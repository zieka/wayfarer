import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handleStop } from '../../src/hooks/stop';

const TEST_DB = '/tmp/wayfarer-test-stop.db';

describe('handleStop', () => {
  beforeEach(() => {
    const db = getDb(TEST_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run(
      'INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
      ['sess-1', '/project', 'fix auth bug', now - 60],
    );
    db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['sess-1', '/project', 'Edit', 'src/auth.ts', 'edited', 'src/auth.ts', now - 30],
    );
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('skips when no observations', () => {
    const db = getDb(TEST_DB);
    db.run('DELETE FROM observations WHERE session_id = ?', ['sess-1']);
    db.close();

    const result = handleStop({ session_id: 'sess-1', cwd: '/project' }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });

  it('returns continue: true immediately (fire-and-forget)', () => {
    // handleStop spawns a detached worker — it should return instantly
    const result = handleStop({ session_id: 'sess-1', cwd: '/project' }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });

  it('returns continue: true for unknown session', () => {
    const result = handleStop({ session_id: 'nonexistent', cwd: '/project' }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });
});
