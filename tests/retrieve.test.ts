import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import {
  estimateTokens, getBudget, fitToBudget, toFtsQuery,
  formatSummaryContext, formatObservationContext, budgetSummaries,
  type SummaryItem, type ObsRow,
  primerForSession,
} from '../src/retrieve';
import { getDb } from '../src/db';

describe('estimateTokens', () => {
  it('is chars/4 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('getBudget', () => {
  const ENV_KEY = 'WAYFARER_CONTEXT_TOKEN_BUDGET';
  let original: string | undefined;
  beforeEach(() => { original = process.env[ENV_KEY]; });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

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
  it('includes a zero-cost item at exactly the budget but stops before exceeding', () => {
    expect(fitToBudget([60, 40, 0], 100, size)).toEqual([60, 40, 0]);
    expect(fitToBudget([60, 40, 1], 100, size)).toEqual([60, 40]);
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

const PRIMER_DB = '/tmp/wayfarer-test-primer.db';

function cleanup(path: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(path + suffix); } catch {}
  }
}

describe('primerForSession', () => {
  beforeEach(() => cleanup(PRIMER_DB));
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
