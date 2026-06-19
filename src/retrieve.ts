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
  return `| ${time} | ${row.tool_name} | ${row.files_touched ?? ''} | ${truncate(row.context, 200)} |`;
}

export function formatSummaryContext(items: SummaryItem[], header: string): string {
  const blocks = items.map(summaryBlock).join('\n\n');
  return `<wayfarer-context>\n## ${header}\n\n${blocks}\n</wayfarer-context>`;
}

export function formatObservationContext(rows: ObsRow[]): string {
  const header = '## Recent relevant work in this project\n\n| Time | Tool | Files | Context |\n|------|------|-------|---------|\n';
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

import { getDb } from './db';

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
      SELECT tool_name, files_touched, created_at, tool_input AS context
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
