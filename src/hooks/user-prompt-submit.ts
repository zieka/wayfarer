import { readStdin } from '../stdin';
import { getDb } from '../db';

export interface HookResponse {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
}

export function handleUserPromptSubmit(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;
  const project = (input.cwd ?? process.cwd()) as string;
  const prompt = (input.prompt ?? null) as string | null;

  const db = getDb(dbPath);
  try {
    db.run(
      'INSERT OR IGNORE INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
      [sessionId, project, prompt, Math.floor(Date.now() / 1000)],
    );
  } finally {
    db.close();
  }

  return { continue: true };
}

// Hook entry point — only runs when executed directly
if (import.meta.main) {
  try {
    const input = await readStdin();
    if (input) {
      const result = handleUserPromptSubmit(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: user-prompt-submit failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
