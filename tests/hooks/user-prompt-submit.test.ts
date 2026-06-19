import { describe, it, expect, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handleUserPromptSubmit } from '../../src/hooks/user-prompt-submit';

const TEST_DB = '/tmp/wayfarer-test-ups.db';

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(TEST_DB + suffix); } catch {}
  }
}

describe('handleUserPromptSubmit', () => {
  afterEach(cleanup);

  it('records the session and always continues', async () => {
    const res = await handleUserPromptSubmit(
      { session_id: 'sX', cwd: '/p', prompt: 'hello world' },
      TEST_DB,
    );
    expect(res.continue).toBe(true);
    const db = getDb(TEST_DB);
    const row = db.query('SELECT prompt FROM sessions WHERE session_id = ?').get('sX') as { prompt: string };
    db.close();
    expect(row.prompt).toBe('hello world');
  });

  it('injects relevant past work when a summary matches the prompt', async () => {
    const db = getDb(TEST_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?,?,?,?)', ['s0', '/p', 'old', now - 1000]);
    db.run(
      `INSERT INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at)
       VALUES (?,?,?,?,?,?)`,
      ['s0', '/p', 'Refactored the authentication token logic.', null, null, now - 1000],
    );
    db.close();
    const res = await handleUserPromptSubmit(
      { session_id: 's1', cwd: '/p', prompt: 'authentication bug' },
      TEST_DB,
    );
    expect(res.continue).toBe(true);
    expect(res.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(res.hookSpecificOutput?.additionalContext).toContain('authentication');
  });

  it('continues with no injection when nothing matches', async () => {
    const res = await handleUserPromptSubmit(
      { session_id: 's2', cwd: '/empty', prompt: 'anything' },
      TEST_DB,
    );
    expect(res.continue).toBe(true);
    expect(res.hookSpecificOutput).toBeUndefined();
  });
});
