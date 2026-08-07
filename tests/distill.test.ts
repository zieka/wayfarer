// tests/distill.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../src/db';
import {
  normalizeTarget, detectErrorRecoveryPairs, correctionHash, distillCorrections,
  type ObservationRow, type RecoveryPair,
} from '../src/distill';

const DB = '/tmp/wayfarer-test-distill.db';
function cleanup() { for (const s of ['', '-wal', '-shm']) { try { unlinkSync(DB + s); } catch {} } }

function row(p: Partial<ObservationRow> & { tool_name: string; is_error: number; created_at: number }): ObservationRow {
  return {
    id: p.id ?? 0, tool_name: p.tool_name, tool_input: p.tool_input ?? '',
    tool_output: p.tool_output ?? '', files_touched: p.files_touched ?? null,
    is_error: p.is_error, created_at: p.created_at,
  };
}
function seedObs(db: ReturnType<typeof getDb>, sessionId: string, o: { tool_name: string; tool_input: string; is_error: number; created_at: number }): number {
  db.run('INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?,?,?)', [sessionId, '/p', o.created_at]);
  return Number(db.run(
    `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, is_error, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [sessionId, '/p', o.tool_name, o.tool_input, '', null, o.is_error, o.created_at],
  ).lastInsertRowid);
}
function seedRecoverablePair(db: ReturnType<typeof getDb>, sessionId: string, cmd: string, t: number) {
  seedObs(db, sessionId, { tool_name: 'Bash', tool_input: JSON.stringify({ command: cmd }), is_error: 1, created_at: t });
  seedObs(db, sessionId, { tool_name: 'Bash', tool_input: JSON.stringify({ command: cmd }), is_error: 0, created_at: t + 1 });
}

describe('normalizeTarget', () => {
  it('extracts the Bash command from JSON tool_input (whitespace-collapsed)', () => {
    expect(normalizeTarget('Bash', JSON.stringify({ command: 'npm   test' }), null)).toBe('npm test');
  });
  it('extracts the file_path from JSON tool_input', () => {
    expect(normalizeTarget('Edit', JSON.stringify({ file_path: '/p/src/a.ts' }), null)).toBe('/p/src/a.ts');
  });
  it('falls back to first files_touched, then raw input', () => {
    expect(normalizeTarget('Read', 'not json', 'src/a.ts,src/b.ts')).toBe('src/a.ts');
    expect(normalizeTarget('Unknown', 'plain', null)).toBe('plain');
  });
});

describe('detectErrorRecoveryPairs', () => {
  const T = (n: number) => 1000 + n;
  it('pairs an error with the EARLIEST later same-target success', () => {
    const rows: ObservationRow[] = [
      row({ id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: T(1) }),
      row({ id: 2, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 0, created_at: T(3) }),
      row({ id: 3, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 0, created_at: T(5) }),
    ];
    const pairs = detectErrorRecoveryPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].error.id).toBe(1);
    expect(pairs[0].recovery.id).toBe(2);
  });
  it('no pair when the later success is on a different target', () => {
    expect(detectErrorRecoveryPairs([
      row({ id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: T(1) }),
      row({ id: 2, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'ls' }), is_error: 0, created_at: T(3) }),
    ])).toHaveLength(0);
  });
  it('no pair when the error is never followed by a same-target success', () => {
    expect(detectErrorRecoveryPairs([
      row({ id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: T(1) }),
      row({ id: 2, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: T(3) }),
    ])).toHaveLength(0);
  });
});

describe('correctionHash', () => {
  it('collides on case/whitespace-normalized text, differs on distinct text', () => {
    expect(correctionHash('Run npm ci  first')).toBe(correctionHash('run   NPM CI first'));
    expect(correctionHash('a')).not.toBe(correctionHash('b'));
  });
});

describe('distillCorrections — no-pair guard', () => {
  beforeEach(cleanup); afterEach(cleanup);
  it('emits zero corrections AND never invokes phrase when there is no error→recovery pair', async () => {
    const db = getDb(DB);
    // an unrecovered error (no later same-target success) + an unrelated success
    seedObs(db, 's1', { tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: 1000 });
    seedObs(db, 's1', { tool_name: 'Read', tool_input: JSON.stringify({ file_path: '/p/x.ts' }), is_error: 0, created_at: 1001 });
    let phraseCalls = 0;
    const spy = async (_pairs: RecoveryPair[]) => { phraseCalls++; return ['SHOULD NOT BE WRITTEN']; };
    const inserted = await distillCorrections(db, 's1', '/p', spy);
    expect(inserted).toBe(0);
    expect(phraseCalls).toBe(0); // the LLM must be unreachable on the no-pair path
    expect((db.query('SELECT COUNT(*) AS n FROM corrections').get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe('distillCorrections — insertion + dedup both directions', () => {
  beforeEach(cleanup); afterEach(cleanup);
  it('inserts a correction for a real error→recovery pair', async () => {
    const db = getDb(DB);
    seedRecoverablePair(db, 's1', 'npm test', 1000);
    expect(await distillCorrections(db, 's1', '/p', async () => ['Run npm ci before npm test.'])).toBe(1);
    expect((db.query('SELECT correction FROM corrections WHERE project = ?').get('/p') as { correction: string }).correction)
      .toBe('Run npm ci before npm test.');
    db.close();
  });
  it('dedups an identical correction and does NOT swallow a different one', async () => {
    const db = getDb(DB);
    seedRecoverablePair(db, 's1', 'npm test', 1000);
    seedRecoverablePair(db, 's2', 'npm test', 2000);
    seedRecoverablePair(db, 's3', 'npm test', 3000);
    expect(await distillCorrections(db, 's1', '/p', async () => ['Run npm ci first.'])).toBe(1);
    expect(await distillCorrections(db, 's2', '/p', async () => ['run   NPM CI first.'])).toBe(0); // normalized-identical → ignored
    expect(await distillCorrections(db, 's3', '/p', async () => ['Pin the Node version in .nvmrc.'])).toBe(1); // different → inserted
    expect((db.query('SELECT COUNT(*) AS n FROM corrections WHERE project = ?').get('/p') as { n: number }).n).toBe(2);
    db.close();
  });
});
