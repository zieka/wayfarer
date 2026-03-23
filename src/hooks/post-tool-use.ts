import { readStdin } from '../stdin';
import { getDb } from '../db';
import { extractFilePaths } from '../files';
import type { HookResponse } from './user-prompt-submit';

export function handlePostToolUse(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;
  const project = (input.cwd ?? process.cwd()) as string;
  const toolName = (input.tool_name ?? 'unknown') as string;
  const toolInput = typeof input.tool_input === 'string'
    ? input.tool_input
    : JSON.stringify(input.tool_input ?? '');
  const toolOutput = typeof input.tool_response === 'string'
    ? input.tool_response
    : JSON.stringify(input.tool_response ?? '');

  const filesTouched = extractFilePaths(toolInput);

  const db = getDb(dbPath);
  try {
    // Ensure session exists (create if hook ordering was unexpected)
    db.run(
      'INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?, ?, ?)',
      [sessionId, project, Math.floor(Date.now() / 1000)],
    );

    db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, project, toolName, toolInput, toolOutput, filesTouched, Math.floor(Date.now() / 1000)],
    );
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
