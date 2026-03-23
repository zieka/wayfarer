import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handleSessionStart } from '../../src/hooks/session-start';

const TEST_DB = '/tmp/wayfarer-test-ss.db';

describe('handleSessionStart', () => {
  beforeEach(() => {
    const db = getDb(TEST_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run(
      'INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
      ['old-sess', '/project', 'previous work', now - 3600],
    );
    db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['old-sess', '/project', 'Edit', 'edited auth.ts', 'done', 'src/auth.ts', now - 3600],
    );
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('returns context when observations exist', () => {
    const result = handleSessionStart({ session_id: 'new-sess', cwd: '/project' }, TEST_DB);
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(result.hookSpecificOutput?.additionalContext).toContain('wayfarer-context');
  });

  it('returns no context for empty project', () => {
    const result = handleSessionStart({ session_id: 'new-sess', cwd: '/other-project' }, TEST_DB);
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('always returns continue: true', () => {
    const result = handleSessionStart({ session_id: 'new-sess', cwd: '/whatever' }, TEST_DB);
    expect(result.continue).toBe(true);
  });
});
