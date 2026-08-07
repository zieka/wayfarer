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
import { pruneOriginals } from './compress';
import { distillCorrections, type RecoveryPair } from './distill';
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

const DISTILL_PROMPT = `You are distilling durable "pitfall" corrections from a coding session. You are given error→recovery pairs: a tool call that FAILED, then a later call on the same target that SUCCEEDED. For each pair where the recovery clearly shows how to avoid the original failure, output ONE terse imperative correction (max ~20 words). If a pair does not clearly imply a reusable fix, omit it. Respond with ONLY a JSON array of strings, e.g. ["Run npm ci before npm test."]. No prose, no fencing.`;

async function distillPhrase(pairs: RecoveryPair[]): Promise<string[]> {
  const payload = pairs.map((p, i) => ({
    n: i + 1,
    tool: p.error.tool_name,
    failed_input: p.error.tool_input.slice(0, 500),
    error_output: p.error.tool_output.slice(0, 500),
    recovery_input: p.recovery.tool_input.slice(0, 500),
  }));
  const prompt = `${DISTILL_PROMPT}\n\nPairs:\n${JSON.stringify(payload, null, 2)}`;
  const responseText = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`claude -p exited with code ${code}`));
    });
    child.on('error', reject);
  });
  try {
    const parsed = JSON.parse(responseText);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return []; // unparseable model output → no corrections (conservative)
  }
}

try {
  const db = getDb(dbPath);

  // TTL-prune expired observation originals FIRST, so cleanup runs regardless of
  // whether summarization succeeds (early exits and claude -p failures skip the rest).
  try {
    pruneOriginals(db, Math.floor(Date.now() / 1000));
  } catch (e) {
    console.error(`wayfarer: prune failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const session = db.query('SELECT prompt, project FROM sessions WHERE session_id = ?')
    .get(sessionId) as { prompt: string | null; project: string } | null;

  if (!session) {
    db.close();
    process.exit(0);
  }

  // Distill error→recovery corrections. Independently guarded and placed BEFORE summary
  // generation: a summary failure can't skip it, and its own failure can't touch the
  // summary or the prune. Gated inside distillCorrections — no pair → no claude call.
  try {
    await distillCorrections(db, sessionId, session.project, distillPhrase);
  } catch (e) {
    console.error(`wayfarer: distillation failed: ${e instanceof Error ? e.message : String(e)}`);
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

  // Embed the summary for vector search
  try {
    const { getEmbedding } = await import('./embed');
    const summaryRow = db.query('SELECT id FROM session_summaries WHERE session_id = ?')
      .get(sessionId) as { id: number } | null;

    if (summaryRow) {
      const embedding = await getEmbedding(result.summary);
      const buffer = Buffer.from(embedding.buffer);
      db.run(
        'INSERT OR REPLACE INTO summary_embeddings (summary_id, embedding) VALUES (?, ?)',
        [summaryRow.id, buffer],
      );
    }
  } catch (e) {
    // Embedding failure is non-fatal — FTS5 search still works
    console.error(`wayfarer: embedding failed: ${(e as Error).message}`);
  }

  db.close();
} catch (e) {
  console.error(`wayfarer: summarize-worker failed: ${(e as Error).message}`);
}

process.exit(0);
