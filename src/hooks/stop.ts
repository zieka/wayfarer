import { readStdin } from '../stdin';
import { getDb } from '../db';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import type { HookResponse } from './user-prompt-submit';

export function handleStop(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;

  const db = getDb(dbPath);
  try {
    // Quick check: does this session have observations worth summarizing?
    const count = db.query(
      'SELECT COUNT(*) as c FROM observations WHERE session_id = ?'
    ).get(sessionId) as { c: number };

    if (count.c === 0) return { continue: true };
  } finally {
    db.close();
  }

  // Spawn detached summarization worker — fire and forget
  // Both stop.js and summarize-worker.js are in the same directory after build
  const workerScript = join(dirname(import.meta.filename), 'summarize-worker.js');
  const args = [workerScript, sessionId];
  if (dbPath) args.push(dbPath);

  spawn('bun', args, {
    detached: true,
    stdio: 'ignore',
  }).unref();

  return { continue: true };
}

if (import.meta.main) {
  try {
    const input = await readStdin();
    if (input) {
      const result = handleStop(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: stop failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
