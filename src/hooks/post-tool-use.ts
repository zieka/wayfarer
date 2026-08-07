import { readStdin } from '../stdin';
import { getDb } from '../db';
import { extractFilePaths } from '../files';
import { compressForStorage, hardTruncate } from '../compress';
import type { HookResponse } from './user-prompt-submit';

export function handlePostToolUse(
  input: Record<string, unknown>,
  dbPath?: string,
  deps: { compress?: typeof compressForStorage } = {},
): HookResponse {
  const compress = deps.compress ?? compressForStorage;
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;
  const project = (input.cwd ?? process.cwd()) as string;
  const toolName = (input.tool_name ?? 'unknown') as string;
  const toolInput = typeof input.tool_input === 'string'
    ? input.tool_input
    : JSON.stringify(input.tool_input ?? '');
  const toolOutput = typeof input.tool_response === 'string'
    ? input.tool_response
    : JSON.stringify(input.tool_response ?? '');

  // Constraint 1: extract file paths from the ORIGINAL input, before compression.
  const filesTouched = extractFilePaths(toolInput);

  // Constraint 2: compression must never block capture.
  let storedInput = toolInput;
  let storedOutput = toolOutput;
  let originalInput: string | null = null;
  let originalOutput: string | null = null;
  try {
    const { input: ci, output: co } = compress(toolName, toolInput, toolOutput);
    storedInput = ci.text;
    storedOutput = co.text;
    originalInput = ci.compressed ? toolInput : null;
    originalOutput = co.compressed ? toolOutput : null;
  } catch (e) {
    storedInput = hardTruncate(toolInput);
    storedOutput = hardTruncate(toolOutput);
    originalInput = null;
    originalOutput = null;
    console.error(`wayfarer: compression failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const db = getDb(dbPath);
  try {
    db.run(
      'INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?, ?, ?)',
      [sessionId, project, now],
    );

    const res = db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, project, toolName, storedInput, storedOutput, filesTouched, now],
    );

    if (originalInput !== null || originalOutput !== null) {
      db.run(
        `INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at)
         VALUES (?, ?, ?, ?)`,
        [res.lastInsertRowid, originalInput, originalOutput, now],
      );
    }
  } finally {
    db.close();
  }

  return { continue: true };
}

if (import.meta.main) {
  try {
    const input = await readStdin();
    if (input) {
      const result = handlePostToolUse(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: post-tool-use failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
