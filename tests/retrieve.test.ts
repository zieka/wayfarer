import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import {
  estimateTokens, getBudget, fitToBudget, toFtsQuery,
  formatSummaryContext, formatObservationContext, budgetSummaries,
  type SummaryItem, type ObsRow,
  primerForSession,
  relevantForPrompt,
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
      { id: 1, tool_name: 'Edit', files_touched: 'src/auth.ts', created_at: NOW - 3600, context: 'edited auth' },
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
    const fit = budgetSummaries(items, 200); // ~100 tokens each block; only ~1 fits
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

const IDDB = '/tmp/wayfarer-test-obsid.db';
function cleanupId() { for (const s of ['', '-wal', '-shm']) { try { unlinkSync(IDDB + s); } catch {} } }

describe('observation-fallback #id column', () => {
  afterEach(cleanupId);

  it('primerForSession fallback includes the observation #id', () => {
    const db = getDb(IDDB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?,?,?)', ['s', '/p', now]);
    const id = db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['s', '/p', 'Edit', 'edited src/auth.ts', 'ok', 'src/auth.ts', now],
    ).lastInsertRowid;
    db.close();
    const out = primerForSession('/p', IDDB); // no summaries → observation fallback
    expect(out).toContain('| Id |');
    expect(out).toContain(`#${Number(id)}`);
  });

  it('relevantForPrompt observation fallback includes the observation #id', async () => {
    const db = getDb(IDDB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?,?,?)', ['s', '/p', now]);
    const id = db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['s', '/p', 'Bash', 'run widgettest', 'output', null, now],
    ).lastInsertRowid;
    db.close();
    // no summaries + no embeddings → observation FTS fallback; embed stub avoids a model load
    const out = await relevantForPrompt('/p', 'widgettest', { dbPath: IDDB, embed: async () => new Float32Array([0, 0, 1]) });
    expect(out).toContain('| Id |');
    expect(out).toContain(`#${Number(id)}`);
  });
});

// tests/retrieve.test.ts — append at END. Do NOT re-import describe/it/expect/afterEach,
// unlinkSync, getDb, or primerForSession — they are already imported at the top of this file.
// ALL consts/helpers below are declared INSIDE the describe block so they cannot collide
// with existing top-level names in this file (e.g. a pre-existing seedSummary/cleanup).

describe('primerForSession — pitfalls injection', () => {
  const PDB = '/tmp/wayfarer-test-pitfalls.db';
  const cleanup = () => { for (const s of ['', '-wal', '-shm']) { try { unlinkSync(PDB + s); } catch {} } };
  afterEach(cleanup);

  const seedSummary = (db: ReturnType<typeof getDb>, project: string, text: string, t: number) => {
    db.run('INSERT OR IGNORE INTO sessions (session_id, project, prompt, started_at) VALUES (?,?,?,?)', ['s', project, 'x', t]);
    db.run('INSERT INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at) VALUES (?,?,?,?,?,?)', ['s', project, text, null, null, t]);
  };
  const seedCorrection = (db: ReturnType<typeof getDb>, project: string, text: string, hash: string, t: number) => {
    db.run('INSERT INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?,?,?,?,?)', [project, text, hash, 's', t]);
  };

  it('prepends a Known pitfalls section ABOVE summaries', () => {
    const db = getDb(PDB);
    const now = Math.floor(Date.now() / 1000);
    seedSummary(db, '/p', 'Did a thing.', now);
    seedCorrection(db, '/p', 'Run npm ci before npm test.', 'h1', now);
    db.close();
    const out = primerForSession('/p', PDB);
    expect(out).toContain('## Known pitfalls in this project');
    expect(out).toContain('Run npm ci before npm test.');
    expect(out).toContain('Did a thing.');
    expect(out!.indexOf('Known pitfalls')).toBeLessThan(out!.indexOf('Did a thing.'));
  });

  it('adds no pitfalls section when there are no corrections (summary path unchanged)', () => {
    const db = getDb(PDB);
    const now = Math.floor(Date.now() / 1000);
    seedSummary(db, '/p', 'Did a thing.', now);
    db.close();
    const out = primerForSession('/p', PDB);
    expect(out).not.toContain('Known pitfalls');
    expect(out).toContain('Did a thing.');
  });

  it('returns just the pitfalls section when corrections exist but no summaries/observations', () => {
    const db = getDb(PDB);
    const now = Math.floor(Date.now() / 1000);
    seedCorrection(db, '/only', 'Avoid X.', 'h1', now);
    db.close();
    const out = primerForSession('/only', PDB);
    expect(out).toContain('## Known pitfalls in this project');
    expect(out).toContain('Avoid X.');
  });

  it('degrades to no pitfalls section (and never throws) when the pitfalls query fails', () => {
    const db = getDb(PDB);
    const now = Math.floor(Date.now() / 1000);
    seedSummary(db, '/p', 'Did a thing.', now);
    db.close();
    let out: string | null = null;
    expect(() => { out = primerForSession('/p', PDB, { pitfalls: () => { throw new Error('boom'); } }); }).not.toThrow();
    // TS narrows `out` to `null` here since the assignment above is inside a closure passed
    // to expect(); cast restores the declared type without changing runtime behavior.
    expect(out as string | null).toContain('Did a thing.');
    expect(out as string | null).not.toContain('Known pitfalls');
  });
});
