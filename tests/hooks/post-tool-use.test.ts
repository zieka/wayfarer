import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handlePostToolUse } from '../../src/hooks/post-tool-use';

const TEST_DB = '/tmp/wayfarer-test-ptu.db';

describe('handlePostToolUse', () => {
  beforeEach(() => {
    // Create session first (foreign key constraint)
    const db = getDb(TEST_DB);
    db.run(
      'INSERT OR IGNORE INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
      ['sess-1', '/tmp/project', 'test prompt', Math.floor(Date.now() / 1000)],
    );
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('stores an observation', () => {
    handlePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp/project',
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: '/tmp/project/src/auth.ts' }),
      tool_response: 'file contents here',
    }, TEST_DB);

    const db = getDb(TEST_DB);
    const obs = db.query('SELECT * FROM observations WHERE session_id = ?').get('sess-1') as any;
    expect(obs).not.toBeNull();
    expect(obs.tool_name).toBe('Read');
    expect(obs.files_touched).toContain('src/auth.ts');
    db.close();
  });

  it('populates FTS index', () => {
    handlePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp/project',
      tool_name: 'Edit',
      tool_input: JSON.stringify({ file_path: '/tmp/project/src/auth.ts' }),
      tool_response: 'edited successfully',
    }, TEST_DB);

    const db = getDb(TEST_DB);
    const fts = db.query(
      "SELECT * FROM observations_fts WHERE observations_fts MATCH 'auth'"
    ).get() as any;
    expect(fts).not.toBeNull();
    db.close();
  });

  it('handles missing session gracefully', () => {
    // session_id that doesn't exist — should still not crash
    const result = handlePostToolUse({
      session_id: 'nonexistent',
      cwd: '/tmp',
      tool_name: 'Read',
      tool_input: '{}',
      tool_response: 'ok',
    }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });

  it('returns continue: true', () => {
    const result = handlePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp/project',
      tool_name: 'Bash',
      tool_input: 'ls',
      tool_response: 'file1 file2',
    }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });
});
