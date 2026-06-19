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
    if (total >= budget) break;
  }
  return out;
}

export function toFtsQuery(prompt: string): string {
  const tokens = (prompt.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  const unique = [...new Set(tokens)].slice(0, 20);
  return unique.map((t) => `"${t}"`).join(' OR ');
}
