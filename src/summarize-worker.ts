/**
 * Detached summarization worker — spawned by the Stop hook.
 * Reads observations from SQLite, calls `claude -p` for summarization,
 * writes the result back to session_summaries. Runs in background,
 * never blocks the conversation.
 *
 * Usage: bun summarize-worker.js <sessionId> [dbPath]
 */

import { getDb } from './db';
import { formatObservations, parseSummaryResponse } from './summarize';
import { spawn } from 'child_process';

const sessionId = process.argv[2];
const dbPath = process.argv[3] || undefined;

if (!sessionId) {
  process.exit(0);
}

const SYSTEM_PROMPT = `You are a concise technical summarizer. Given a list of tool observations from a coding session, produce a JSON response with three fields:
- "summary": 2-3 sentence narrative of what was accomplished
- "files_read": array of file paths that were read
- "files_edited": array of file paths that were created or modified

Focus on what changed and why, not the mechanics of each tool call. Respond with only the JSON object, no markdown fencing.`;

try {
  const db = getDb(dbPath);
  const session = db.query('SELECT prompt, project FROM sessions WHERE session_id = ?')
    .get(sessionId) as { prompt: string | null; project: string } | null;

  if (!session) {
    db.close();
    process.exit(0);
  }

  const observations = db.query(
    'SELECT tool_name, tool_input, tool_output FROM observations WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as Array<{ tool_name: string; tool_input: string; tool_output: string }>;

  if (observations.length === 0) {
    db.close();
    process.exit(0);
  }

  const content = formatObservations(session.prompt, observations);
  const prompt = `${SYSTEM_PROMPT}\n\n${content}`;

  // Call claude -p for summarization (uses Max subscription, no API cost)
  const responseText = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', () => {}); // discard stderr
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude -p exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });

  const result = parseSummaryResponse(responseText);

  db.run(
    `INSERT OR REPLACE INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, session.project, result.summary, result.files_read, result.files_edited, Math.floor(Date.now() / 1000)],
  );

  db.close();
} catch (e) {
  console.error(`wayfarer: summarize-worker failed: ${(e as Error).message}`);
}

process.exit(0);
