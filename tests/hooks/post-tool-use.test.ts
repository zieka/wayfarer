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

  it('stores compressed output and preserves the original for a large output', () => {
    const bigOutput = Array.from({ length: 400 }, (_, i) => `output row ${i}`).join('\n');
    handlePostToolUse({
      session_id: 'sess-1', cwd: '/tmp/project', tool_name: 'Bash',
      tool_input: 'run build', tool_response: bigOutput,
    }, TEST_DB);

    const db = getDb(TEST_DB);
    const obs = db.query('SELECT id, tool_output FROM observations WHERE session_id = ? ORDER BY id DESC')
      .get('sess-1') as { id: number; tool_output: string };
    expect(obs.tool_output.length).toBeLessThan(bigOutput.length);
    const orig = db.query('SELECT tool_output_full FROM observation_originals WHERE observation_id = ?')
      .get(obs.id) as { tool_output_full: string } | null;
    expect(orig?.tool_output_full).toBe(bigOutput);
    db.close();
  });

  it('stores small output verbatim with no originals row', () => {
    handlePostToolUse({
      session_id: 'sess-1', cwd: '/tmp/project', tool_name: 'Bash',
      tool_input: 'echo hi', tool_response: 'hi',
    }, TEST_DB);

    const db = getDb(TEST_DB);
    const obs = db.query('SELECT id, tool_output FROM observations WHERE session_id = ? ORDER BY id DESC')
      .get('sess-1') as { id: number; tool_output: string };
    expect(obs.tool_output).toBe('hi');
    const orig = db.query('SELECT observation_id FROM observation_originals WHERE observation_id = ?')
      .get(obs.id) as unknown;
    expect(orig).toBeNull();
    db.close();
  });

  // Constraint 1: file-path extraction runs on the ORIGINAL input, before compression.
  it('extracts files_touched from a path in the compressed-away middle of a large input', () => {
    // Pad each line so the document comfortably exceeds the 2048-char threshold
    // (otherwise compression won't trigger and the assertions below are vacuous).
    const pad = '.'.repeat(20);
    const head = Array.from({ length: 60 }, (_, i) => `prefix line ${i} ${pad}`);
    const buried = 'see /tmp/project/src/deep/buried.ts for details';
    const tail = Array.from({ length: 60 }, (_, i) => `suffix line ${i} ${pad}`);
    const bigInput = [...head, buried, ...tail].join('\n'); // ~4KB; buried path at line 60 (in the dropped middle)

    handlePostToolUse({
      session_id: 'sess-1', cwd: '/tmp/project', tool_name: 'Read',
      tool_input: bigInput, tool_response: 'ok',
    }, TEST_DB);

    const db = getDb(TEST_DB);
    const obs = db.query('SELECT tool_input, files_touched FROM observations WHERE session_id = ? ORDER BY id DESC')
      .get('sess-1') as { tool_input: string; files_touched: string | null };
    // files_touched came from the ORIGINAL (extraction before compression)
    expect(obs.files_touched).toContain('src/deep/buried.ts');
    // and the stored input was compressed, dropping the buried path from the row
    expect(obs.tool_input.length).toBeLessThan(bigInput.length);
    expect(obs.tool_input).not.toContain('buried.ts');
    db.close();
  });

  // Constraint 2: a throwing compressor must not block capture or throw.
  it('still inserts the observation and returns normally when compression throws', () => {
    const throwingCompress = () => { throw new Error('boom'); };
    let result: unknown;
    expect(() => {
      result = handlePostToolUse({
        session_id: 'sess-1', cwd: '/tmp/project', tool_name: 'Bash',
        tool_input: 'x'.repeat(5000), tool_response: 'y'.repeat(5000),
      }, TEST_DB, { compress: throwingCompress as any });
    }).not.toThrow();
    expect(result).toEqual({ continue: true });

    const db = getDb(TEST_DB);
    const obs = db.query('SELECT id FROM observations WHERE session_id = ? ORDER BY id DESC')
      .get('sess-1') as { id: number } | null;
    expect(obs).not.toBeNull();
    // failure path saves no originals
    const orig = db.query('SELECT observation_id FROM observation_originals WHERE observation_id = ?')
      .get(obs!.id) as unknown;
    expect(orig).toBeNull();
    db.close();
  });

  it('stores is_error=1 when the payload signals an error (tool_response.is_error)', () => {
    handlePostToolUse({
      session_id: 'sess-1', cwd: '/tmp/project', tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'ls /nope' }),
      tool_response: { is_error: true, output: 'ls: /nope: not found' },
    }, TEST_DB);
    const db = getDb(TEST_DB);
    const obs = db.query('SELECT is_error FROM observations WHERE session_id = ? ORDER BY id DESC').get('sess-1') as { is_error: number };
    expect(obs.is_error).toBe(1);
    db.close();
  });

  it('stores is_error=1 via the output heuristic when there is no payload flag', () => {
    handlePostToolUse({
      session_id: 'sess-1', cwd: '/tmp/project', tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'cat missing.txt' }),
      tool_response: 'cat: missing.txt: No such file or directory',
    }, TEST_DB);
    const db = getDb(TEST_DB);
    const obs = db.query('SELECT is_error FROM observations WHERE session_id = ? ORDER BY id DESC').get('sess-1') as { is_error: number };
    expect(obs.is_error).toBe(1);
    db.close();
  });

  it('stores is_error=0 for a normal success', () => {
    handlePostToolUse({
      session_id: 'sess-1', cwd: '/tmp/project', tool_name: 'Edit',
      tool_input: JSON.stringify({ file_path: '/tmp/project/src/a.ts' }),
      tool_response: 'File edited successfully',
    }, TEST_DB);
    const db = getDb(TEST_DB);
    const obs = db.query('SELECT is_error FROM observations WHERE session_id = ? ORDER BY id DESC').get('sess-1') as { is_error: number };
    expect(obs.is_error).toBe(0);
    db.close();
  });

  it('never throws while detecting is_error (odd payload)', () => {
    expect(() => handlePostToolUse({
      session_id: 'sess-1', cwd: '/tmp/project', tool_name: 'Bash',
      tool_input: 'x', tool_response: { is_error: { nested: 'weird' } },
    }, TEST_DB)).not.toThrow();
  });
});
