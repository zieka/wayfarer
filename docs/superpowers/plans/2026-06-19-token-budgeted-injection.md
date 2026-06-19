# Token-budgeted, relevance-ranked context injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wayfarer's fixed-row recency context dump with token-budgeted, relevance-ranked injection at both SessionStart (recency primer) and UserPromptSubmit (FTS5-first, vector-fallback retrieval).

**Architecture:** A new `src/retrieve.ts` module owns all retrieval/ranking/budget/format logic as small, independently testable units. Two entry points compose them: `primerForSession` (sync, no query) and `relevantForPrompt` (async, query-driven, injectable embedder). `src/context.ts` is removed and its logic migrates in. The two hooks call the entry points.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (FTS5 + vector BLOBs), `bun:test`, `fastembed` (BGE-small, lazy-loaded only on vector fallback).

## Global Constraints

- Hooks are short-lived Bun processes; retrieval must **never block or crash** a prompt — on any error, inject nothing and return `{ continue: true }`.
- No new DB columns, no migrations (schema is at `user_version = 3`).
- No daemon / no persistent embedder; `fastembed` is loaded per-process only when the vector fallback fires.
- Token estimation is dependency-free `chars/4`.
- Default token budget `1200`, overridable via env `WAYFARER_CONTEXT_TOKEN_BUDGET`.
- Constants: `CANDIDATE_CAP = 30`, `MIN_FTS_RESULTS = 3`, `VECTOR_THRESHOLD = 0.3`, `MAX_PROMPT_CHARS = 2000`.
- Test DB convention: `/tmp/wayfarer-test-*.db`; `afterEach` unlinks `.db`, `-wal`, `-shm`.
- Reuse the existing recency-weighted FTS rank formula verbatim: `(rank * -1.0) * (1.0 / (1.0 + (now - created_at) / 86400.0))`.

---

### Task 1: Pure budget/query units in `src/retrieve.ts`

**Files:**
- Create: `src/retrieve.ts`
- Test: `tests/retrieve.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `estimateTokens(text: string): number`
  - `getBudget(): number`
  - `fitToBudget<T>(items: T[], budget: number, sizeOf: (item: T) => number): T[]`
  - `toFtsQuery(prompt: string): string`
  - Exported consts `CANDIDATE_CAP = 30`, `MIN_FTS_RESULTS = 3`, `VECTOR_THRESHOLD = 0.3`, `MAX_PROMPT_CHARS = 2000`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/retrieve.test.ts
import { describe, it, expect } from 'bun:test';
import { estimateTokens, getBudget, fitToBudget, toFtsQuery } from '../src/retrieve';

describe('estimateTokens', () => {
  it('is chars/4 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('getBudget', () => {
  it('defaults to 1200 when env unset', () => {
    delete process.env.WAYFARER_CONTEXT_TOKEN_BUDGET;
    expect(getBudget()).toBe(1200);
  });
  it('honors a valid override', () => {
    process.env.WAYFARER_CONTEXT_TOKEN_BUDGET = '600';
    expect(getBudget()).toBe(600);
    delete process.env.WAYFARER_CONTEXT_TOKEN_BUDGET;
  });
  it('falls back to 1200 on invalid override', () => {
    process.env.WAYFARER_CONTEXT_TOKEN_BUDGET = 'nope';
    expect(getBudget()).toBe(1200);
    delete process.env.WAYFARER_CONTEXT_TOKEN_BUDGET;
  });
});

describe('fitToBudget', () => {
  const size = (n: number) => n;
  it('returns [] for empty input', () => {
    expect(fitToBudget<number>([], 100, size)).toEqual([]);
  });
  it('keeps all when they fit', () => {
    expect(fitToBudget([10, 20, 30], 100, size)).toEqual([10, 20, 30]);
  });
  it('stops before exceeding budget', () => {
    expect(fitToBudget([40, 40, 40], 100, size)).toEqual([40, 40]);
  });
  it('always returns at least the first item even if it exceeds budget', () => {
    expect(fitToBudget([500, 10], 100, size)).toEqual([500]);
  });
});

describe('toFtsQuery', () => {
  it('returns empty string when no usable tokens', () => {
    expect(toFtsQuery('   ?? ')).toBe('');
  });
  it('quotes and OR-joins tokens, dropping duplicates', () => {
    expect(toFtsQuery('Fix the auth auth bug')).toBe('"fix" OR "the" OR "auth" OR "bug"');
  });
  it('neutralizes FTS operators and punctuation', () => {
    // parens/quotes/colons must not reach MATCH as syntax
    expect(toFtsQuery('foo("bar"): baz')).toBe('"foo" OR "bar" OR "baz"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/retrieve.test.ts`
Expected: FAIL — cannot resolve `../src/retrieve` / exports undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/retrieve.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/retrieve.test.ts`
Expected: PASS (all of Task 1's tests).

- [ ] **Step 5: Commit**

```bash
git add src/retrieve.ts tests/retrieve.test.ts
git commit -m "feat: budget/query primitives for context retrieval"
```

---

### Task 2: Formatters + shared helpers in `src/retrieve.ts`

**Files:**
- Modify: `src/retrieve.ts`
- Test: `tests/retrieve.test.ts`

**Interfaces:**
- Consumes: `estimateTokens` (Task 1).
- Produces:
  - `interface SummaryItem { summary: string; files_read: string | null; files_edited: string | null; created_at: number }`
  - `interface ObsRow { tool_name: string; files_touched: string | null; created_at: number; context: string }`
  - `formatSummaryContext(items: SummaryItem[], header: string): string`
  - `formatObservationContext(rows: ObsRow[]): string`
  - `budgetSummaries(items: SummaryItem[], budget: number): SummaryItem[]` (greedy fit + at-least-one truncation)
  - `summaryBlock(item: SummaryItem): string`, `obsLine(row: ObsRow): string` (exported for budget sizing/tests)

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/retrieve.test.ts
import {
  formatSummaryContext, formatObservationContext, budgetSummaries,
  type SummaryItem, type ObsRow,
} from '../src/retrieve';

const NOW = Math.floor(Date.now() / 1000);

describe('formatSummaryContext', () => {
  it('wraps blocks with header and context tags, dedupes files', () => {
    const items: SummaryItem[] = [
      { summary: 'Fixed auth bug.', files_read: 'src/auth.ts', files_edited: 'src/auth.ts,tests/auth.test.ts', created_at: NOW - 3600 },
    ];
    const out = formatSummaryContext(items, 'Relevant past work');
    expect(out).toContain('<wayfarer-context>');
    expect(out).toContain('## Relevant past work');
    expect(out).toContain('Fixed auth bug.');
    expect(out).toContain('Files: src/auth.ts, tests/auth.test.ts');
    expect(out).toContain('</wayfarer-context>');
  });
});

describe('formatObservationContext', () => {
  it('renders the markdown table', () => {
    const rows: ObsRow[] = [
      { tool_name: 'Edit', files_touched: 'src/auth.ts', created_at: NOW - 3600, context: 'edited auth' },
    ];
    const out = formatObservationContext(rows);
    expect(out).toContain('| Time | Tool | Files | Context |');
    expect(out).toContain('| Edit |');
    expect(out).toContain('src/auth.ts');
  });
});

describe('budgetSummaries', () => {
  it('drops items beyond the budget', () => {
    const mk = (i: number): SummaryItem => ({ summary: 'x'.repeat(400), files_read: null, files_edited: null, created_at: NOW - i });
    const items = [mk(1), mk(2), mk(3), mk(4)];
    const fit = budgetSummaries(items, 200); // ~100 tokens each block; only ~2 fit
    expect(fit.length).toBeGreaterThanOrEqual(1);
    expect(fit.length).toBeLessThan(items.length);
  });
  it('truncates a single oversized summary to fit', () => {
    const huge: SummaryItem = { summary: 'y'.repeat(20000), files_read: null, files_edited: null, created_at: NOW };
    const fit = budgetSummaries([huge], 100);
    expect(fit).toHaveLength(1);
    expect(fit[0].summary.length).toBeLessThan(20000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/retrieve.test.ts`
Expected: FAIL — `formatSummaryContext`/`budgetSummaries` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/retrieve.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/retrieve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieve.ts tests/retrieve.test.ts
git commit -m "feat: context formatters and summary budgeting"
```

---

### Task 3: `primerForSession` (SessionStart entry point)

**Files:**
- Modify: `src/retrieve.ts`
- Test: `tests/retrieve.test.ts`

**Interfaces:**
- Consumes: `getDb` (`src/db.ts`), `budgetSummaries`, `formatSummaryContext`, `fitToBudget`, `obsLine`, `formatObservationContext`, `estimateTokens`, `getBudget`, `CANDIDATE_CAP`.
- Produces: `primerForSession(project: string, dbPath?: string): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/retrieve.test.ts
import { unlinkSync } from 'fs';
import { getDb } from '../src/db';
import { primerForSession } from '../src/retrieve';

const PRIMER_DB = '/tmp/wayfarer-test-primer.db';

function cleanup(path: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(path + suffix); } catch {}
  }
}

describe('primerForSession', () => {
  afterEach(() => cleanup(PRIMER_DB));

  it('returns a budgeted summary block when summaries exist', () => {
    const db = getDb(PRIMER_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?,?,?,?)', ['s1', '/p', 'x', now]);
    db.run(
      `INSERT INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at)
       VALUES (?,?,?,?,?,?)`,
      ['s1', '/p', 'Fixed the auth token expiry bug.', 'src/auth.ts', 'src/auth.ts', now - 3600],
    );
    db.close();
    const out = primerForSession('/p', PRIMER_DB);
    expect(out).toContain('## Recent work in this project');
    expect(out).toContain('Fixed the auth token expiry bug.');
  });

  it('falls back to observations when no summaries', () => {
    const db = getDb(PRIMER_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?,?,?,?)', ['s1', '/p', 'x', now]);
    db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['s1', '/p', 'Edit', 'edited auth.ts', 'ok', 'src/auth.ts', now - 60],
    );
    db.close();
    const out = primerForSession('/p', PRIMER_DB);
    expect(out).toContain('| Time | Tool |');
    expect(out).toContain('auth.ts');
  });

  it('returns null for an empty project', () => {
    const db = getDb(PRIMER_DB);
    db.close();
    expect(primerForSession('/nope', PRIMER_DB)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/retrieve.test.ts`
Expected: FAIL — `primerForSession` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/retrieve.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/retrieve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieve.ts tests/retrieve.test.ts
git commit -m "feat: primerForSession recency injection with budget"
```

---

### Task 4: `relevantForPrompt` (UserPromptSubmit entry point, FTS5 + vector fallback)

**Files:**
- Modify: `src/retrieve.ts`
- Test: `tests/retrieve.test.ts`

**Interfaces:**
- Consumes: everything above, plus `cosineSimilarity` from `src/embed.ts` and a lazily-imported `getEmbedding`.
- Produces: `relevantForPrompt(project: string, prompt: string, opts?: { dbPath?: string; embed?: (text: string) => Promise<Float32Array> }): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/retrieve.test.ts
import { relevantForPrompt } from '../src/retrieve';

const REL_DB = '/tmp/wayfarer-test-rel.db';

function insertSummary(db: ReturnType<typeof getDb>, id: number, sid: string, summary: string, createdAt: number) {
  db.run('INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?,?,?,?)', [sid, '/p', 'x', createdAt]);
  db.run(
    `INSERT INTO session_summaries (id, session_id, project, summary, files_read, files_edited, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id, sid, '/p', summary, null, null, createdAt],
  );
}

function insertEmbedding(db: ReturnType<typeof getDb>, summaryId: number, vec: number[]) {
  const buf = Buffer.from(new Float32Array(vec).buffer);
  db.run('INSERT INTO summary_embeddings (summary_id, embedding) VALUES (?, ?)', [summaryId, buf]);
}

describe('relevantForPrompt', () => {
  afterEach(() => cleanup(REL_DB));

  it('returns FTS5 keyword matches without invoking the embedder', async () => {
    const db = getDb(REL_DB);
    const now = Math.floor(Date.now() / 1000);
    insertSummary(db, 1, 's1', 'Refactored the authentication token logic.', now - 100);
    insertSummary(db, 2, 's2', 'Updated the billing invoice renderer.', now - 200);
    insertSummary(db, 3, 's3', 'Tuned authentication retries and timeouts.', now - 300);
    insertSummary(db, 4, 's4', 'Reworked authentication session storage.', now - 400);
    db.close();
    let embedCalled = false;
    const out = await relevantForPrompt('/p', 'authentication problem', {
      dbPath: REL_DB,
      embed: async () => { embedCalled = true; return new Float32Array([1, 0, 0]); },
    });
    expect(out).toContain('## Relevant past work');
    expect(out).toContain('authentication');
    expect(embedCalled).toBe(false);
  });

  it('falls back to vector search when FTS5 is weak', async () => {
    const db = getDb(REL_DB);
    const now = Math.floor(Date.now() / 1000);
    insertSummary(db, 1, 's1', 'Refactored the deployment pipeline.', now - 100);
    insertSummary(db, 2, 's2', 'Adjusted the caching layer.', now - 200);
    insertEmbedding(db, 1, [1, 0, 0]); // close to query vector
    insertEmbedding(db, 2, [0, 1, 0]); // orthogonal -> below threshold
    db.close();
    const out = await relevantForPrompt('/p', 'zzz qqq', {
      dbPath: REL_DB,
      embed: async () => new Float32Array([1, 0, 0]),
    });
    expect(out).toContain('## Relevant past work');
    expect(out).toContain('deployment pipeline');
    expect(out).not.toContain('caching layer');
  });

  it('returns null when nothing matches and no embeddings exist', async () => {
    const db = getDb(REL_DB);
    const now = Math.floor(Date.now() / 1000);
    insertSummary(db, 1, 's1', 'Adjusted the caching layer.', now - 100);
    db.close();
    const out = await relevantForPrompt('/p', 'zzz qqq', {
      dbPath: REL_DB,
      embed: async () => new Float32Array([0, 0, 1]),
    });
    expect(out).toBeNull();
  });

  it('falls back to observation FTS when a keyword hits only observations', async () => {
    const db = getDb(REL_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?,?,?,?)', ['s1', '/p', 'x', now]);
    db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['s1', '/p', 'Bash', 'pytest tests/widget_test.py', 'ok', null, now - 60],
    );
    db.close();
    const out = await relevantForPrompt('/p', 'widget', {
      dbPath: REL_DB,
      embed: async () => new Float32Array([0, 0, 1]),
    });
    expect(out).toContain('| Time | Tool |');
    expect(out).toContain('widget');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/retrieve.test.ts`
Expected: FAIL — `relevantForPrompt` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/retrieve.ts
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
    const embedFn = embed ?? (await import('./embed')).getEmbedding;
    const { cosineSimilarity } = await import('./embed');
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
          SELECT o.tool_name, o.files_touched, o.created_at,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/retrieve.test.ts`
Expected: PASS (all `relevantForPrompt` cases, including the embedder-not-called assertion).

- [ ] **Step 5: Commit**

```bash
git add src/retrieve.ts tests/retrieve.test.ts
git commit -m "feat: relevantForPrompt with FTS5-first vector fallback"
```

---

### Task 5: Wire SessionStart to the primer; remove `context.ts`

**Files:**
- Modify: `src/hooks/session-start.ts`
- Modify: `tests/hooks/session-start.test.ts`
- Delete: `src/context.ts`, `tests/context.test.ts`

**Interfaces:**
- Consumes: `primerForSession` (Task 3).
- Produces: unchanged `handleSessionStart(input, dbPath?): HookResponse`.

- [ ] **Step 1: Confirm no other importers of `context.ts`**

Run: `grep -rn "from '\.\./context'\|from './context'\|src/context" src tests`
Expected: only `src/hooks/session-start.ts` and `tests/context.test.ts`. If anything else appears, update it to import from `../retrieve` before deleting.

- [ ] **Step 2: Update the SessionStart hook**

```ts
// src/hooks/session-start.ts
import { readStdin } from '../stdin';
import { primerForSession } from '../retrieve';
import type { HookResponse } from './user-prompt-submit';

export function handleSessionStart(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const project = (input.cwd ?? process.cwd()) as string;

  const context = primerForSession(project, dbPath);

  if (context) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    };
  }

  return { continue: true };
}

if (import.meta.main) {
  try {
    const input = await readStdin();
    const result = handleSessionStart(input ?? { cwd: process.cwd() });
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    console.error(`wayfarer: session-start failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
```

- [ ] **Step 3: Delete the obsolete module and its test**

```bash
git rm src/context.ts tests/context.test.ts
```

(The behaviors `context.test.ts` covered — summary-preferred injection and observation fallback — are now covered by `primerForSession` tests in Task 3.)

- [ ] **Step 4: Run the SessionStart hook tests**

Run: `bun test tests/hooks/session-start.test.ts`
Expected: PASS — the existing assertions (`hookEventName === 'SessionStart'`, `additionalContext` contains `wayfarer-context`, empty project → no output) still hold because the observation fallback preserves behavior.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: SessionStart uses primerForSession; remove context.ts"
```

---

### Task 6: Wire UserPromptSubmit to inject relevant context

**Files:**
- Modify: `src/hooks/user-prompt-submit.ts`
- Modify: `tests/hooks/user-prompt-submit.test.ts`

**Interfaces:**
- Consumes: `relevantForPrompt` (Task 4).
- Produces: `handleUserPromptSubmit(input, dbPath?): Promise<HookResponse>` (now async). `HookResponse` interface unchanged.

- [ ] **Step 1: Write/Update the failing test**

```ts
// tests/hooks/user-prompt-submit.test.ts
import { describe, it, expect, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handleUserPromptSubmit } from '../../src/hooks/user-prompt-submit';

const TEST_DB = '/tmp/wayfarer-test-ups.db';

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(TEST_DB + suffix); } catch {}
  }
}

describe('handleUserPromptSubmit', () => {
  afterEach(cleanup);

  it('records the session and always continues', async () => {
    const res = await handleUserPromptSubmit(
      { session_id: 'sX', cwd: '/p', prompt: 'hello world' },
      TEST_DB,
    );
    expect(res.continue).toBe(true);
    const db = getDb(TEST_DB);
    const row = db.query('SELECT prompt FROM sessions WHERE session_id = ?').get('sX') as { prompt: string };
    db.close();
    expect(row.prompt).toBe('hello world');
  });

  it('injects relevant past work when a summary matches the prompt', async () => {
    const db = getDb(TEST_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?,?,?,?)', ['s0', '/p', 'old', now - 1000]);
    db.run(
      `INSERT INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at)
       VALUES (?,?,?,?,?,?)`,
      ['s0', '/p', 'Refactored the authentication token logic.', null, null, now - 1000],
    );
    db.close();
    const res = await handleUserPromptSubmit(
      { session_id: 's1', cwd: '/p', prompt: 'authentication bug' },
      TEST_DB,
    );
    expect(res.continue).toBe(true);
    expect(res.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(res.hookSpecificOutput?.additionalContext).toContain('authentication');
  });

  it('continues with no injection when nothing matches', async () => {
    const res = await handleUserPromptSubmit(
      { session_id: 's2', cwd: '/empty', prompt: 'anything' },
      TEST_DB,
    );
    expect(res.continue).toBe(true);
    expect(res.hookSpecificOutput).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hooks/user-prompt-submit.test.ts`
Expected: FAIL — current handler is sync and never sets `hookSpecificOutput`.

- [ ] **Step 3: Update the UserPromptSubmit hook**

```ts
// src/hooks/user-prompt-submit.ts
import { readStdin } from '../stdin';
import { getDb } from '../db';
import { relevantForPrompt } from '../retrieve';

export interface HookResponse {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
}

export async function handleUserPromptSubmit(
  input: Record<string, unknown>,
  dbPath?: string,
): Promise<HookResponse> {
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

  if (prompt) {
    try {
      const context = await relevantForPrompt(project, prompt, { dbPath });
      if (context) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: context,
          },
        };
      }
    } catch (e) {
      console.error(`wayfarer: relevant-context lookup failed: ${(e as Error).message}`);
    }
  }

  return { continue: true };
}

// Hook entry point — only runs when executed directly
if (import.meta.main) {
  try {
    const input = await readStdin();
    if (input) {
      const result = await handleUserPromptSubmit(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: user-prompt-submit failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/hooks/user-prompt-submit.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and build**

Run: `bun test`
Expected: PASS — entire suite green (no remaining references to `context.ts`).

Run: `bun run build`
Expected: builds `plugin/scripts/*.js` without errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: UserPromptSubmit injects relevance-ranked context"
```

---

## Self-Review

**Spec coverage:**
- Both injection points → Tasks 5 (SessionStart/`primerForSession`) + 6 (UserPromptSubmit/`relevantForPrompt`). ✓
- FTS5-first, vector fallback (`MIN_FTS_RESULTS`, dedup by `summary_id`, keyword-first merge) → Task 4. ✓
- Token budget ~1200 env-overridable, `chars/4` → Task 1 (`getBudget`, `estimateTokens`), applied in Tasks 2–4. ✓
- `toFtsQuery` sanitizer + `try/catch` around MATCH → Tasks 1 + 4. ✓
- At-least-one + truncation → Task 1 (`fitToBudget`) + Task 2 (`budgetSummaries`). ✓
- Injectable embedder for tests → Task 4. ✓
- Prompt truncation to `MAX_PROMPT_CHARS` before embedding/FTS → Task 4. ✓
- Observation fallbacks (fresh projects) → Tasks 3 + 4. ✓
- Never block a prompt (try/catch, `{continue:true}`) → Tasks 4 + 6. ✓
- Remove `context.ts`, update importers, migrate tests → Task 5. ✓
- No schema changes → honored (no migration steps anywhere). ✓

**Placeholder scan:** none — every code step has full code; every run step has an exact command and expected result.

**Type consistency:** `SummaryItem`/`ObsRow`/`ScoredSummary` defined in Tasks 2/4 and used consistently; `primerForSession` (sync) and `relevantForPrompt` (async, `opts.embed`) signatures match their call sites in Tasks 5/6; `handleUserPromptSubmit` becomes `Promise<HookResponse>` and its entry point awaits it. `formatSummaryContext(items, header)` adds the `## ` prefix — callers pass header text without `##`. ✓
