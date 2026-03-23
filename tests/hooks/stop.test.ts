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

  it('skips summarization when no API key', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await handleStop({ session_id: 'sess-1', cwd: '/project' }, TEST_DB);
      expect(result).toEqual({ continue: true });
      const db = getDb(TEST_DB);
      const summary = db.query('SELECT * FROM session_summaries WHERE session_id = ?').get('sess-1');
      expect(summary).toBeNull();
      db.close();
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('skips summarization when no observations', async () => {
    const db = getDb(TEST_DB);
    db.run('DELETE FROM observations WHERE session_id = ?', ['sess-1']);
    db.close();

    const result = await handleStop({ session_id: 'sess-1', cwd: '/project' }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });

  it('returns continue: true always', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await handleStop({ session_id: 'sess-1', cwd: '/project' }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });
});
