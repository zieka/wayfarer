import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../src/db';
import { compressionMarker } from '../src/compress';
import { retrieveOriginal, formatRetrieveResult } from '../src/retrieve-original';

const DB = '/tmp/wayfarer-test-retrieve.db';

function cleanup() {
  for (const s of ['', '-wal', '-shm']) { try { unlinkSync(DB + s); } catch {} }
}

// Seeds one observation; writes an observation_originals row iff inputFull/outputFull is provided.
function seedObservation(
  db: ReturnType<typeof getDb>,
  opts: { toolInput: string; toolOutput: string; inputFull?: string | null; outputFull?: string | null },
): number {
  const now = Math.floor(Date.now() / 1000);
  db.run('INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?,?,?)', ['s1', '/p', now]);
  const id = db.run(
    `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    ['s1', '/p', 'Bash', opts.toolInput, opts.toolOutput, null, now],
  ).lastInsertRowid;
  if (opts.inputFull !== undefined || opts.outputFull !== undefined) {
    db.run(
      'INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at) VALUES (?,?,?,?)',
      [id, opts.inputFull ?? null, opts.outputFull ?? null, now],
    );
  }
  return Number(id);
}

describe('retrieveOriginal — three-state resolution', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('state 1: original present → returns the true original, expired:false', () => {
    const db = getDb(DB);
    const compressed = `first line\n${compressionMarker('dropped 200 lines')}\nlast line`;
    const trueOriginal = 'the full uncompressed output with everything intact';
    const id = seedObservation(db, { toolInput: 'cmd', toolOutput: compressed, outputFull: trueOriginal });
    const r = retrieveOriginal(db, id);
    db.close();
    expect(r.found).toBe(true);
    expect(r.output).toEqual({ text: trueOriginal, expired: false });
    expect(r.output!.text).not.toBe(compressed);
  });

  it('state 2: marker present but no originals row → expired:true (compressed, original pruned)', () => {
    const db = getDb(DB);
    const compressed = `first line\n${compressionMarker('dropped 200 lines')}\nlast line`;
    const id = seedObservation(db, { toolInput: 'cmd', toolOutput: compressed }); // no originals row
    const r = retrieveOriginal(db, id);
    db.close();
    expect(r.output).toEqual({ text: compressed, expired: true });
  });

  it('state 3: no marker and no originals row → never-compressed, expired:false (stored is full)', () => {
    const db = getDb(DB);
    const stored = 'short uncompressed output, no marker';
    const id = seedObservation(db, { toolInput: 'cmd', toolOutput: stored }); // no originals row
    const r = retrieveOriginal(db, id);
    db.close();
    expect(r.output).toEqual({ text: stored, expired: false });
  });

  it('distinguishes expired from never-compressed in BOTH directions', () => {
    const db = getDb(DB);
    const withMarker = `x\n${compressionMarker('dropped 9 lines')}\ny`;
    const withoutMarker = 'plain output';
    const expiredId = seedObservation(db, { toolInput: 'a', toolOutput: withMarker });   // marker, no originals
    const cleanId = seedObservation(db, { toolInput: 'b', toolOutput: withoutMarker });  // no marker, no originals
    const expired = retrieveOriginal(db, expiredId);
    const clean = retrieveOriginal(db, cleanId);
    db.close();
    expect(expired.output!.expired).toBe(true);   // marker ⇒ expired
    expect(clean.output!.expired).toBe(false);    // no marker ⇒ never-compressed
  });
});

describe('retrieveOriginal — other cases', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('returns found:false for an unknown id', () => {
    const db = getDb(DB);
    const r = retrieveOriginal(db, 99999);
    db.close();
    expect(r).toEqual({ found: false, observationId: 99999 });
  });

  it('resolves input and output independently', () => {
    const db = getDb(DB);
    const inputCompressed = `in-head\n${compressionMarker('dropped 5 lines')}\nin-tail`; // marker, no full → expired
    const outputCompressed = `out-head\n${compressionMarker('dropped 7 lines')}\nout-tail`;
    const outputFull = 'the preserved full output';
    const id = seedObservation(db, { toolInput: inputCompressed, toolOutput: outputCompressed, outputFull });
    const r = retrieveOriginal(db, id);
    db.close();
    expect(r.input).toEqual({ text: inputCompressed, expired: true });  // input original gone
    expect(r.output).toEqual({ text: outputFull, expired: false });     // output original preserved
  });
});

describe('formatRetrieveResult', () => {
  it('renders not-found wording', () => {
    expect(formatRetrieveResult({ found: false, observationId: 7 })).toContain('no observation with id 7');
  });
  it('renders both fields and flags an expired one', () => {
    const out = formatRetrieveResult({
      found: true, observationId: 3, toolName: 'Bash', createdAt: 0,
      input: { text: 'full in', expired: false },
      output: { text: 'compressed out', expired: true },
    });
    expect(out).toContain('Observation #3');
    expect(out).toContain('full in');
    expect(out).toContain('compressed out');
    expect(out).toContain('original expired');
  });
});
