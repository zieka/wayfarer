import { describe, it, expect, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../src/db';

const TEST_DB = '/tmp/wayfarer-test.db';

describe('getDb', () => {
  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('creates database with WAL mode', () => {
    const db = getDb(TEST_DB);
    const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe('wal');
    db.close();
  });

  it('creates sessions table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('sessions');
    db.close();
  });

  it('creates observations table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('observations');
    db.close();
  });

  it('creates FTS5 virtual table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('observations_fts');
    db.close();
  });

  it('creates session_summaries table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('session_summaries');
    db.close();
  });

  it('creates session_summaries_fts virtual table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('session_summaries_fts');
    db.close();
  });

  it('creates summary_embeddings table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='summary_embeddings'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('summary_embeddings');
    db.close();
  });

  it('creates observation_originals table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observation_originals'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('observation_originals');
    db.close();
  });

  it('runs migrations idempotently', () => {
    const db1 = getDb(TEST_DB);
    db1.close();
    const db2 = getDb(TEST_DB);
    const version = db2.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(5);
    db2.close();
  });

  it('adds is_error column to observations', () => {
    const db = getDb(TEST_DB);
    const cols = db.query("PRAGMA table_info(observations)").all() as Array<{ name: string; dflt_value: string | null }>;
    const isError = cols.find((c) => c.name === 'is_error');
    expect(isError).toBeDefined();
    expect(isError!.dflt_value).toBe('0');
    db.close();
  });

  it('creates corrections table', () => {
    const db = getDb(TEST_DB);
    const t = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='corrections'"
    ).get() as { name: string } | null;
    expect(t?.name).toBe('corrections');
    db.close();
  });

  it('enforces UNIQUE(project, content_hash) on corrections', () => {
    const db = getDb(TEST_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?,?,?,?,?)', ['/p', 'a', 'h1', 's1', now]);
    const dup = db.run('INSERT OR IGNORE INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?,?,?,?,?)', ['/p', 'a again', 'h1', 's2', now]);
    expect(dup.changes).toBe(0); // same (project, content_hash) ignored
    const diff = db.run('INSERT OR IGNORE INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?,?,?,?,?)', ['/p', 'b', 'h2', 's3', now]);
    expect(diff.changes).toBe(1); // different hash inserts
    db.close();
  });
});
