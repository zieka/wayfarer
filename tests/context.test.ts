import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../src/db';
import { buildContext } from '../src/context';

const TEST_DB = '/tmp/wayfarer-test-ctx.db';

function seedData(db: ReturnType<typeof getDb>) {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    'INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
    ['s1', '/project', 'fix auth', now - 86400],
  );
  db.run(
    `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['s1', '/project', 'Edit', 'edited auth.ts', 'success', 'src/auth.ts', now - 86400],
  );
  db.run(
    `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['s1', '/project', 'Bash', 'npm test', 'all passed', null, now - 3600],
  );
}

describe('buildContext', () => {
  beforeEach(() => {
    const db = getDb(TEST_DB);
    seedData(db);
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('returns recent observations for project with no query', () => {
    const ctx = buildContext('/project', undefined, TEST_DB);
    expect(ctx).toContain('auth.ts');
    expect(ctx).toContain('Edit');
  });

  it('returns null for empty database', () => {
    const emptyDb = '/tmp/wayfarer-test-ctx-empty.db';
    const ctx = buildContext('/project', undefined, emptyDb);
    try { unlinkSync(emptyDb); } catch {}
    try { unlinkSync(emptyDb + '-wal'); } catch {}
    try { unlinkSync(emptyDb + '-shm'); } catch {}
    expect(ctx).toBeNull();
  });

  it('searches with FTS when query provided', () => {
    const ctx = buildContext('/project', 'auth', TEST_DB);
    expect(ctx).toContain('auth');
  });

  it('wraps output in wayfarer-context tags', () => {
    const ctx = buildContext('/project', undefined, TEST_DB);
    expect(ctx).toContain('<wayfarer-context>');
    expect(ctx).toContain('</wayfarer-context>');
  });
});

describe('buildContext with summaries', () => {
  beforeEach(() => {
    const db = getDb(TEST_DB);
    seedData(db);
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['s1', '/project', 'Fixed the auth token expiry bug. Added validation and tests.', 'src/auth.ts', 'src/auth.ts,tests/auth.test.ts', now - 3600],
    );
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('prefers summaries over raw observations', () => {
    const ctx = buildContext('/project', undefined, TEST_DB);
    expect(ctx).toContain('Fixed the auth token expiry bug');
    expect(ctx).not.toContain('| Time | Tool |');
  });

  it('falls back to observations when no summaries', () => {
    const db = getDb(TEST_DB);
    db.run('DELETE FROM session_summaries');
    db.close();
    const ctx = buildContext('/project', undefined, TEST_DB);
    expect(ctx).toContain('| Time | Tool |');
  });
});
