import { readStdin } from '../stdin';
import { getDb } from '../db';
import { formatObservations, parseSummaryResponse, callAnthropic } from '../summarize';
import type { HookResponse } from './user-prompt-submit';

export async function handleStop(
  input: Record<string, unknown>,
  dbPath?: string,
): Promise<HookResponse> {
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('wayfarer: skipping summarization (no API key)');
    return { continue: true };
  }

  const db = getDb(dbPath);
  try {
    const session = db.query('SELECT prompt, project FROM sessions WHERE session_id = ?')
      .get(sessionId) as { prompt: string | null; project: string } | null;

    if (!session) return { continue: true };

    const observations = db.query(
      'SELECT tool_name, tool_input, tool_output FROM observations WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as Array<{ tool_name: string; tool_input: string; tool_output: string }>;

    if (observations.length === 0) return { continue: true };

    const content = formatObservations(session.prompt, observations);
    const responseText = await callAnthropic(content);
    const result = parseSummaryResponse(responseText);

    db.run(
      `INSERT OR REPLACE INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, session.project, result.summary, result.files_read, result.files_edited, Math.floor(Date.now() / 1000)],
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
      const result = await handleStop(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: stop failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
