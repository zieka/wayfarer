import { describe, it, expect, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handleUserPromptSubmit } from '../../src/hooks/user-prompt-submit';

const TEST_DB = '/tmp/wayfarer-test-ups.db';

describe('handleUserPromptSubmit', () => {
  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('creates a session record', () => {
    const db = getDb(TEST_DB);
    handleUserPromptSubmit({
      session_id: 'sess-1',
      cwd: '/Users/kyle/project',
      prompt: 'fix the auth bug',
    }, TEST_DB);

    const session = db.query('SELECT * FROM sessions WHERE session_id = ?').get('sess-1') as any;
    expect(session).not.toBeNull();
    expect(session.project).toBe('/Users/kyle/project');
    expect(session.prompt).toBe('fix the auth bug');
    expect(session.status).toBe('active');
    db.close();
  });

  it('is idempotent for same session_id', () => {
    handleUserPromptSubmit({ session_id: 'sess-1', cwd: '/tmp', prompt: 'first' }, TEST_DB);
    handleUserPromptSubmit({ session_id: 'sess-1', cwd: '/tmp', prompt: 'second' }, TEST_DB);

    const db = getDb(TEST_DB);
    const count = db.query('SELECT COUNT(*) as c FROM sessions WHERE session_id = ?').get('sess-1') as any;
    expect(count.c).toBe(1);
    db.close();
  });

  it('returns continue: true', () => {
    const result = handleUserPromptSubmit({
      session_id: 'sess-2',
      cwd: '/tmp',
      prompt: 'hello',
    }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });
});
