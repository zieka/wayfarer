import { getDb } from './db';

const DEFAULT_BUDGET = 1200;
export const CANDIDATE_CAP = 30;
export const MIN_FTS_RESULTS = 3;
export const VECTOR_THRESHOLD = 0.3;
export const MAX_PROMPT_CHARS = 2000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function getBudget(): number {
  const raw = process.env.WAYFARER_CONTEXT_TOKEN_BUDGET;
  if (!raw) return DEFAULT_BUDGET;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
}

export function fitToBudget<T>(items: T[], budget: number, sizeOf: (item: T) => number): T[] {
  const out: T[] = [];
  let total = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (out.length > 0 && total + size > budget) break;
    out.push(item);
    total += size;
  }
  return out;
}

export function toFtsQuery(prompt: string): string {
  const tokens = (prompt.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  const unique = [...new Set(tokens)].slice(0, 20);
  return unique.map((t) => `"${t}"`).join(' OR ');
}

export interface SummaryItem {
  summary: string;
  files_read: string | null;
  files_edited: string | null;
  created_at: number;
}

export interface ObsRow {
  id: number;
  tool_name: string;
  files_touched: string | null;
  created_at: number;
  context: string;
}

const HEADER_OVERHEAD_TOKENS = 12;

function formatTimeAgo(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '...';
}

function dedupeFiles(read: string | null, edited: string | null): string {
  return [read, edited]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((f) => f.trim())
    .filter((f, i, arr) => f && arr.indexOf(f) === i)
    .join(', ');
}

export function summaryBlock(item: SummaryItem): string {
  const time = formatTimeAgo(item.created_at);
  const files = dedupeFiles(item.files_read, item.files_edited);
  const filesLine = files ? `\nFiles: ${files}` : '';
  return `**${time}:** ${item.summary}${filesLine}`;
}

export function obsLine(row: ObsRow): string {
  const time = formatTimeAgo(row.created_at);
  return `| #${row.id} | ${time} | ${row.tool_name} | ${row.files_touched ?? ''} | ${truncate(row.context, 200)} |`;
}

export function formatSummaryContext(items: SummaryItem[], header: string): string {
  const blocks = items.map(summaryBlock).join('\n\n');
  return `<wayfarer-context>\n## ${header}\n\n${blocks}\n</wayfarer-context>`;
}

export function formatObservationContext(rows: ObsRow[]): string {
  const header = '## Recent relevant work in this project\n\n| Id | Time | Tool | Files | Context |\n|------|------|------|-------|---------|\n';
  return `<wayfarer-context>\n${header}${rows.map(obsLine).join('\n')}\n</wayfarer-context>`;
}

export function budgetSummaries(items: SummaryItem[], budget: number): SummaryItem[] {
  const cap = Math.max(1, budget - HEADER_OVERHEAD_TOKENS);
  const fit = fitToBudget(items, cap, (i) => estimateTokens(summaryBlock(i)) + 1);
  if (fit.length === 1 && estimateTokens(summaryBlock(fit[0])) > budget) {
    const maxChars = Math.max(40, cap * 4);
    fit[0] = { ...fit[0], summary: fit[0].summary.slice(0, maxChars) + '...' };
  }
  return fit;
}

interface ScoredSummary extends SummaryItem {
  summary_id: number;
  score?: number;
}

async function vectorCandidates(
  db: ReturnType<typeof getDb>,
  project: string,
  prompt: string,
  embed?: (text: string) => Promise<Float32Array>,
): Promise<ScoredSummary[]> {
  try {
    const mod = await import('./embed');
    const embedFn = embed ?? mod.getEmbedding;
    const { cosineSimilarity } = mod;
    const queryEmbedding = await embedFn(prompt.slice(0, MAX_PROMPT_CHARS));

    const rows = db.query(`
      SELECT e.summary_id, e.embedding, s.summary, s.files_read, s.files_edited, s.created_at
      FROM summary_embeddings e
      JOIN session_summaries s ON s.id = e.summary_id
      WHERE s.project = ?
    `).all(project) as (ScoredSummary & { embedding: Buffer })[];

    return rows
      .map((r) => {
        const emb = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
        return { ...r, score: cosineSimilarity(queryEmbedding, emb) };
      })
      .filter((r) => (r.score ?? 0) >= VECTOR_THRESHOLD)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, CANDIDATE_CAP);
  } catch {
    return [];
  }
}

export async function relevantForPrompt(
  project: string,
  prompt: string,
  opts: { dbPath?: string; embed?: (text: string) => Promise<Float32Array> } = {},
): Promise<string | null> {
  const db = getDb(opts.dbPath);
  try {
    const budget = getBudget();
    const now = Math.floor(Date.now() / 1000);
    const ftsQuery = toFtsQuery(prompt.slice(0, MAX_PROMPT_CHARS));

    let candidates: ScoredSummary[] = [];
    if (ftsQuery) {
      try {
        candidates = db.query(`
          SELECT s.id AS summary_id, s.summary, s.files_read, s.files_edited, s.created_at
          FROM session_summaries_fts
          JOIN session_summaries s ON s.id = session_summaries_fts.rowid
          WHERE session_summaries_fts MATCH ? AND s.project = ?
          ORDER BY (rank * -1.0) * (1.0 / (1.0 + (? - s.created_at) / 86400.0)) DESC
          LIMIT ?
        `).all(ftsQuery, project, now, CANDIDATE_CAP) as ScoredSummary[];
      } catch {
        candidates = [];
      }
    }

    if (candidates.length < MIN_FTS_RESULTS) {
      const vec = await vectorCandidates(db, project, prompt, opts.embed);
      const seen = new Set(candidates.map((c) => c.summary_id));
      for (const v of vec) {
        if (!seen.has(v.summary_id)) {
          candidates.push(v);
          seen.add(v.summary_id);
        }
      }
    }

    if (candidates.length > 0) {
      return formatSummaryContext(budgetSummaries(candidates, budget), 'Relevant past work');
    }

    if (ftsQuery) {
      try {
        const rows = db.query(`
          SELECT o.id, o.tool_name, o.files_touched, o.created_at,
                 snippet(observations_fts, 1, '', '', '...', 32) AS context
          FROM observations_fts
          JOIN observations o ON o.id = observations_fts.rowid
          WHERE observations_fts MATCH ? AND o.project = ?
          ORDER BY (rank * -1.0) * (1.0 / (1.0 + (? - o.created_at) / 86400.0)) DESC
          LIMIT ?
        `).all(ftsQuery, project, now, CANDIDATE_CAP) as ObsRow[];
        if (rows.length > 0) {
          return formatObservationContext(fitToBudget(rows, budget, (r) => estimateTokens(obsLine(r))));
        }
      } catch {
        // ignore FTS errors — never block a prompt
      }
    }

    return null;
  } finally {
    db.close();
  }
}

export function primerForSession(project: string, dbPath?: string): string | null {
  const db = getDb(dbPath);
  try {
    const budget = getBudget();

    const summaries = db.query(`
      SELECT summary, files_read, files_edited, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(project, CANDIDATE_CAP) as SummaryItem[];

    if (summaries.length > 0) {
      return formatSummaryContext(budgetSummaries(summaries, budget), 'Recent work in this project');
    }

    const rows = db.query(`
      SELECT id, tool_name, files_touched, created_at, tool_input AS context
      FROM observations
      WHERE project = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(project, CANDIDATE_CAP) as ObsRow[];

    if (rows.length === 0) return null;
    const fit = fitToBudget(rows, budget, (r) => estimateTokens(obsLine(r)));
    return formatObservationContext(fit);
  } finally {
    db.close();
  }
}
