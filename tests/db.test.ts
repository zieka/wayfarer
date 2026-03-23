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

  it('runs migrations idempotently', () => {
    const db1 = getDb(TEST_DB);
    db1.close();
    const db2 = getDb(TEST_DB);
    const version = db2.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(1);
    db2.close();
  });
});
