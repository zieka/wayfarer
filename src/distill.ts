// src/distill.ts
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

export interface ObservationRow {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  files_touched: string | null;
  is_error: number;
  created_at: number;
}

export interface RecoveryPair {
  error: ObservationRow;
  recovery: ObservationRow;
}

const BASH_TOOLS = new Set(['Bash', 'BashOutput']);

export function normalizeTarget(toolName: string, toolInput: string, filesTouched: string | null): string {
  let target = '';
  try {
    const parsed = JSON.parse(toolInput) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      if (BASH_TOOLS.has(toolName) && typeof parsed.command === 'string') target = parsed.command;
      else if (typeof parsed.file_path === 'string') target = parsed.file_path;
    }
  } catch {
    // tool_input isn't JSON — fall through to the fallbacks
  }
  if (!target && filesTouched) target = filesTouched.split(',')[0] ?? '';
  if (!target) target = toolInput;
  return target.trim().replace(/\s+/g, ' ');
}

export function detectErrorRecoveryPairs(observations: ObservationRow[]): RecoveryPair[] {
  const sorted = [...observations].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const pairs: RecoveryPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const error = sorted[i];
    if (error.is_error !== 1) continue;
    const target = normalizeTarget(error.tool_name, error.tool_input, error.files_touched);
    for (let j = i + 1; j < sorted.length; j++) {
      const recovery = sorted[j];
      if (recovery.is_error !== 0) continue;
      if (recovery.tool_name !== error.tool_name) continue;
      if (normalizeTarget(recovery.tool_name, recovery.tool_input, recovery.files_touched) !== target) continue;
      pairs.push({ error, recovery });
      break; // earliest later success
    }
  }
  return pairs;
}

export function correctionHash(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export async function distillCorrections(
  db: Database,
  sessionId: string,
  project: string,
  phrase: (pairs: RecoveryPair[]) => Promise<string[]>,
): Promise<number> {
  const observations = db.query(
    `SELECT id, tool_name, tool_input, tool_output, files_touched, is_error, created_at
     FROM observations WHERE session_id = ? ORDER BY created_at ASC`,
  ).all(sessionId) as ObservationRow[];

  const pairs = detectErrorRecoveryPairs(observations);
  if (pairs.length === 0) return 0; // no observed recovery → never call phrase, never write a fabricated fix

  const corrections = await phrase(pairs);
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  for (const raw of corrections) {
    const text = (raw ?? '').trim();
    if (!text) continue;
    const res = db.run(
      'INSERT OR IGNORE INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [project, text, correctionHash(text), sessionId, now],
    );
    if (res.changes > 0) inserted++;
  }
  return inserted;
}
