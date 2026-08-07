# Reversible Retrieve Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model expand a compressed observation back to its full original on demand, via a tested `retrieveOriginal` + a built `plugin/scripts/retrieve.js` invoked by a `wayfarer-retrieve` skill — surfacing observation ids so it knows what to expand, and folding in two directly-related deferred minors (marker unification, prune-cutoff boundary test).

**Architecture:** New `src/retrieve-original.ts` holds the read-only retrieval logic (`retrieveOriginal`), formatting (`formatRetrieveResult`), and a testable CLI core (`runRetrieve`) with a thin `import.meta.main` entry built to `plugin/scripts/retrieve.js`. `src/compress.ts` centralizes markers behind `compressionMarker` + a no-`g` `COMPRESSION_MARKER_RE` (load-bearing: it distinguishes an expired-original from a never-compressed field). `src/retrieve.ts` and the search skill surface observation ids.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (WAL + FTS5), `bun:test`, esbuild (plugin build), Claude Code plugin skills.

## Global Constraints

- **`retrieveOriginal` is strictly read-only** — no writes, no prune, no side effects; there is no cleanup to order against a failure path.
- **Three-state resolution (per field, `input`/`output`):** (1) `observation_originals.<field>_full` non-null → return it, `expired:false`; (2) else stored `observations.<field>` matches `COMPRESSION_MARKER_RE` → return stored, `expired:true` (compressed, original pruned); (3) else → return stored, `expired:false` (never compressed; stored IS the full value). The **expired (2) vs never-compressed (3)** pair must be asserted in BOTH directions.
- **CLI always exits 0**, but its output text must distinguish: **not found** → `no observation with id <N>`; **real failure** (DB unreadable / corrupt row / any thrown error) → `error retrieving observation <N>: <message>`. Conflating them is a silent failure.
- **Marker unification is behavior-preserving:** `compressionMarker(detail)` returns exactly `… [wayfarer: ${detail}] …`; `hardTruncate` keeps its leading `\n`; the head/tail budget outputs of `compressGeneric`/`compressLog` stay byte-identical. All pre-existing compression tests must pass unchanged.
- `COMPRESSION_MARKER_RE` has **no `g` flag** — `.test()` is stateless and stable across repeated calls.
- **`pruneOriginals` uses strict `<`:** a row at `created_at === cutoff` is KEPT; `created_at === cutoff - 1` is deleted (`cutoff = now - getOriginalsTtlDays()*86400`).
- The `#id` column in the observation-fallback table is compact; the summary injection path adds ZERO tokens.
- Skill invocation: `bun "$CLAUDE_PLUGIN_ROOT/scripts/retrieve.js" <observationId>`. Confirm the skill is discovered like `plugin/skills/search/SKILL.md`; register in `scripts/dev-install.ts`/marketplace only if skills are enumerated explicitly.
- No new DB migration; no `compressed` column (the marker detector does the disambiguation).
- Neutral naming throughout — markers keep the `wayfarer:` prefix; the skill is `wayfarer-retrieve`; no external project name anywhere.
- Test DB convention: `/tmp/wayfarer-test-*.db`; `afterEach` unlinks `.db`, `-wal`, `-shm`.
- `bun test` prints a Bun C++ panic AFTER the `N pass, 0 fail` summary (nonzero exit) — known upstream shutdown bug; judge success by the pass/fail line, not the exit code.

## Tasks

1. **Marker unification + prune-cutoff test** — `compressionMarker` + `COMPRESSION_MARKER_RE` in `compress.ts` (refactor 4 sites, behavior-preserving); tests for marker format, detector (matches 3 variants, not plain text, no-`g` statelessness), and the `created_at === cutoff` boundary for `pruneOriginals`.
2. **`retrieveOriginal` + `formatRetrieveResult`** — new `src/retrieve-original.ts` with the three-state resolution and formatting; the three named three-state tests (expired-vs-never-compressed both directions), `found:false`, independent per-field resolution, and format wording.
3. **`runRetrieve` CLI core + entry** — testable CLI seam (injectable `openDb`/`retrieve`) + `import.meta.main`; tests for valid id, invalid/missing id, thrown-DB-error → error wording (NOT not-found), corrupt-row via injected throw.
4. **Build wiring + `wayfarer-retrieve` skill** — `scripts/build.ts` builds `plugin/scripts/retrieve.js`; new `plugin/skills/retrieve/SKILL.md`; confirm skill discovery; smoke-run the built script.
5. **Surface `#id` (fallback table + search skill) + gate** — `src/retrieve.ts` `ObsRow.id` + `#id` column; update `tests/retrieve.test.ts`; `plugin/skills/search/SKILL.md` id + expandable; full-suite + `bun run build` gate.

---

### Task 1: Marker unification + prune-cutoff test

**Files:**
- Modify: `src/compress.ts`
- Test: `tests/compress.test.ts`

**Interfaces:**
- Consumes: existing `compress.ts` internals (`MAX_COMPRESSED_CHARS`, `HEAD_LINES`/`TAIL_LINES`, `getOriginalsTtlDays`, `pruneOriginals`) and the schema from feature #2.
- Produces:
  - `compressionMarker(detail: string): string` → exactly `… [wayfarer: ${detail}] …`
  - `COMPRESSION_MARKER_RE: RegExp` → `/\[wayfarer: [^\]]*\]/` (no `g` flag)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/compress.test.ts — merge the two new names into the existing `../src/compress` import,
// then add these describes.
import { compressionMarker, COMPRESSION_MARKER_RE } from '../src/compress';

describe('compressionMarker', () => {
  it('wraps the detail in the canonical wayfarer marker', () => {
    expect(compressionMarker('dropped 5 lines')).toBe('… [wayfarer: dropped 5 lines] …');
  });
});

describe('COMPRESSION_MARKER_RE', () => {
  it('matches each marker variant', () => {
    expect(COMPRESSION_MARKER_RE.test(compressionMarker('dropped 3 chars'))).toBe(true);
    expect(COMPRESSION_MARKER_RE.test(compressionMarker('dropped 12 lines'))).toBe(true);
    expect(COMPRESSION_MARKER_RE.test(compressionMarker('dropped middle for size'))).toBe(true);
  });
  it('does not match plain text', () => {
    expect(COMPRESSION_MARKER_RE.test('just some normal tool output')).toBe(false);
  });
  it('is stateless across repeated calls (no g flag)', () => {
    const s = compressionMarker('dropped 1 lines');
    expect(COMPRESSION_MARKER_RE.test(s)).toBe(true);
    expect(COMPRESSION_MARKER_RE.test(s)).toBe(true); // a /g regex would flip to false here
  });
});
```

```ts
// tests/compress.test.ts — add inside the existing `describe('pruneOriginals', ...)` block
// (it already defines PRUNE_DB, cleanupPrune, and imports getDb/pruneOriginals/unlinkSync).
  it('keeps a row exactly at the cutoff and deletes one just past it (strict <)', () => {
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS; // default 14 days
    const db = getDb(PRUNE_DB);
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 14 * 86400;
    db.run('INSERT INTO sessions (session_id, project, started_at) VALUES (?,?,?)', ['s1', '/p', now]);
    const mkObs = (createdAt: number) => db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['s1', '/p', 'Bash', 'in', 'out', null, createdAt],
    ).lastInsertRowid;
    const atCutoff = mkObs(cutoff);
    const pastCutoff = mkObs(cutoff - 1);
    db.run('INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at) VALUES (?,?,?,?)', [atCutoff, null, 'full-at', cutoff]);
    db.run('INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at) VALUES (?,?,?,?)', [pastCutoff, null, 'full-past', cutoff - 1]);

    const deleted = pruneOriginals(db, now);
    expect(deleted).toBe(1); // only the past-cutoff row
    const rows = db.query('SELECT observation_id FROM observation_originals').all() as Array<{ observation_id: number }>;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].observation_id)).toBe(Number(atCutoff)); // exactly-at-cutoff survives
    db.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/compress.test.ts`
Expected: FAIL — `compressionMarker` / `COMPRESSION_MARKER_RE` not exported; the cutoff-boundary test is new.

- [ ] **Step 3: Refactor `compress.ts` (behavior-preserving)**

Add, right after the `MAX_COMPRESSED_CHARS` constant block:

```ts
export function compressionMarker(detail: string): string {
  return `… [wayfarer: ${detail}] …`;
}

// No `g` flag — `.test()` must be stateless. Distinguishes a compressed-but-pruned
// field (marker present, original gone) from a never-compressed field.
export const COMPRESSION_MARKER_RE = /\[wayfarer: [^\]]*\]/;
```

Then replace the marker string literals in the three functions with `compressionMarker(...)`, keeping output byte-identical:

```ts
export function hardTruncate(text: string): string {
  if (text.length <= MAX_COMPRESSED_CHARS) return text;
  const dropped = text.length - MAX_COMPRESSED_CHARS;
  return text.slice(0, MAX_COMPRESSED_CHARS) + '\n' + compressionMarker(`dropped ${dropped} chars`);
}
```

```ts
export function compressGeneric(text: string): string {
  const lines = text.split('\n');
  if (lines.length > HEAD_LINES + TAIL_LINES + 1) {
    const head = lines.slice(0, HEAD_LINES).join('\n');
    const tail = lines.slice(lines.length - TAIL_LINES).join('\n');
    const droppedLines = lines.length - HEAD_LINES - TAIL_LINES;
    const marker = compressionMarker(`dropped ${droppedLines} lines`);
    const full = `${head}\n${marker}\n${tail}`;
    if (full.length <= MAX_COMPRESSED_CHARS) return full;
    const budget = Math.max(0, MAX_COMPRESSED_CHARS - marker.length - 2);
    const half = Math.floor(budget / 2);
    const headPart = head.length > half ? head.slice(0, half) : head;
    const tailPart = tail.length > half ? tail.slice(tail.length - half) : tail;
    return `${headPart}\n${marker}\n${tailPart}`;
  }
  return hardTruncate(text);
}
```

```ts
export function compressLog(text: string): string {
  const lines = text.split('\n');
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < Math.min(CONTEXT_LINES, lines.length); i++) keep[i] = true;
  for (let i = Math.max(0, lines.length - SUMMARY_LINES); i < lines.length; i++) keep[i] = true;
  let signalCount = 0;
  for (let i = 0; i < lines.length && signalCount < MAX_SIGNAL_LINES; i++) {
    if (!keep[i] && isSignal(lines[i])) { keep[i] = true; signalCount++; }
  }
  const out: string[] = [];
  let droppedRun = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (droppedRun > 0) { out.push(compressionMarker(`dropped ${droppedRun} lines`)); droppedRun = 0; }
      out.push(lines[i]);
    } else {
      droppedRun++;
    }
  }
  if (droppedRun > 0) out.push(compressionMarker(`dropped ${droppedRun} lines`));
  const result = out.join('\n');
  if (result.length <= MAX_COMPRESSED_CHARS) return result;
  const sizeMarker = compressionMarker('dropped middle for size');
  const budget = Math.max(0, MAX_COMPRESSED_CHARS - sizeMarker.length - 2);
  const half = Math.floor(budget / 2);
  return `${result.slice(0, half)}\n${sizeMarker}\n${result.slice(result.length - half)}`;
}
```

Leave `getCompressThreshold`, `getOriginalsTtlDays`, `pickStrategy`, `isSignal`, `compressField`, `compressForStorage`, and `pruneOriginals` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/compress.test.ts`
Expected: PASS — new marker/detector/cutoff tests plus all pre-existing compression tests (byte-identical marker output means none of them change).

- [ ] **Step 5: Commit**

```bash
git add src/compress.ts tests/compress.test.ts
git commit -m "feat: unify compression markers with a detector; prune-cutoff boundary test"
```

---

### Task 2: `retrieveOriginal` + `formatRetrieveResult`

**Files:**
- Create: `src/retrieve-original.ts`
- Test: `tests/retrieve-original.test.ts`

**Interfaces:**
- Consumes: `COMPRESSION_MARKER_RE` (Task 1, `src/compress.ts`); `getDb` (test only); `bun:sqlite` `Database` type.
- Produces:
  - `interface RetrievedField { text: string; expired: boolean }`
  - `interface RetrieveResult { found: boolean; observationId: number; toolName?: string; createdAt?: number; input?: RetrievedField; output?: RetrievedField }`
  - `retrieveOriginal(db: Database, observationId: number): RetrieveResult`
  - `formatRetrieveResult(r: RetrieveResult): string`
- Note: this task does NOT add `runRetrieve` or an `import.meta.main` entry — that is Task 3. The file must still compile/import cleanly.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/retrieve-original.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/retrieve-original.test.ts`
Expected: FAIL — cannot resolve `../src/retrieve-original` / exports undefined.

- [ ] **Step 3: Write the implementation**

```ts
// src/retrieve-original.ts
import type { Database } from 'bun:sqlite';
import { COMPRESSION_MARKER_RE } from './compress';

export interface RetrievedField {
  text: string;
  expired: boolean; // true = was compressed but the original is gone (TTL-pruned)
}

export interface RetrieveResult {
  found: boolean;
  observationId: number;
  toolName?: string;
  createdAt?: number;
  input?: RetrievedField;
  output?: RetrievedField;
}

export function retrieveOriginal(db: Database, observationId: number): RetrieveResult {
  const obs = db.query(
    'SELECT tool_name, tool_input, tool_output, created_at FROM observations WHERE id = ?',
  ).get(observationId) as
    { tool_name: string; tool_input: string; tool_output: string; created_at: number } | null;
  if (!obs) return { found: false, observationId };

  const orig = db.query(
    'SELECT tool_input_full, tool_output_full FROM observation_originals WHERE observation_id = ?',
  ).get(observationId) as
    { tool_input_full: string | null; tool_output_full: string | null } | null;

  // Three-state resolution: preserved original → stored-with-marker (expired) → stored (never compressed).
  const resolve = (full: string | null | undefined, stored: string): RetrievedField => {
    if (full != null) return { text: full, expired: false };
    if (COMPRESSION_MARKER_RE.test(stored)) return { text: stored, expired: true };
    return { text: stored, expired: false };
  };

  return {
    found: true,
    observationId,
    toolName: obs.tool_name,
    createdAt: obs.created_at,
    input: resolve(orig?.tool_input_full, obs.tool_input),
    output: resolve(orig?.tool_output_full, obs.tool_output),
  };
}

export function formatRetrieveResult(r: RetrieveResult): string {
  if (!r.found) return `wayfarer-retrieve: no observation with id ${r.observationId}\n`;
  const when = new Date((r.createdAt ?? 0) * 1000).toISOString();
  const field = (label: string, f?: RetrievedField): string => {
    if (!f) return '';
    const note = f.expired ? ' (original expired — showing compressed form)' : '';
    return `### ${label}${note}\n${f.text}\n`;
  };
  return `## Observation #${r.observationId} — ${r.toolName} @ ${when}\n` +
    field('Input', r.input) + field('Output', r.output);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/retrieve-original.test.ts`
Expected: PASS (all three-state, independence, not-found, and format cases).

- [ ] **Step 5: Commit**

```bash
git add src/retrieve-original.ts tests/retrieve-original.test.ts
git commit -m "feat: retrieveOriginal three-state resolution and result formatting"
```

---

### Task 3: `runRetrieve` CLI core + entry

**Files:**
- Modify: `src/retrieve-original.ts` (append the CLI core + `import.meta.main` entry + `getDb` import)
- Test: `tests/retrieve-original.test.ts` (append CLI tests)

**Interfaces:**
- Consumes: `retrieveOriginal`, `formatRetrieveResult` (Task 2); `getDb` (`src/db.ts`); `Database` type (already imported).
- Produces: `runRetrieve(args: string[], deps?: { openDb?: (dbPath?: string) => Database; retrieve?: typeof retrieveOriginal }): string`
- Behavior: the CLI always returns a string and (via the entry) exits 0. It must distinguish **not found** (`no observation with id <N>`, from `retrieveOriginal`/`formatRetrieveResult`) from **real failure** (`error retrieving observation <N>: <message>`, from the catch). `openDb`/`retrieve` are injectable so the thrown-error path is testable.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/retrieve-original.test.ts — append; merge `runRetrieve` into the existing `../src/retrieve-original` import.
import { runRetrieve } from '../src/retrieve-original';

describe('runRetrieve (CLI core)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('formats a found observation for a valid id', () => {
    const db = getDb(DB);
    const id = seedObservation(db, { toolInput: 'echo hi', toolOutput: 'hi there' });
    db.close();
    const out = runRetrieve([String(id), DB]);
    expect(out).toContain(`Observation #${id}`);
    expect(out).toContain('hi there');
  });

  it('returns a usage message for a missing or non-numeric id', () => {
    expect(runRetrieve([])).toContain('positive integer observation id');
    expect(runRetrieve(['abc'])).toContain('positive integer observation id');
    expect(runRetrieve(['0'])).toContain('positive integer observation id');
    expect(runRetrieve(['-3'])).toContain('positive integer observation id');
  });

  it('returns not-found wording for an unknown id (real DB)', () => {
    const db = getDb(DB); db.close(); // materialize the schema
    const out = runRetrieve(['4242', DB]);
    expect(out).toContain('no observation with id 4242');
  });

  it('a thrown DB error produces the ERROR wording, NOT the not-found wording', () => {
    const boom = ((_p?: string) => { throw new Error('database disk image is malformed'); });
    const out = runRetrieve(['5'], { openDb: boom });
    expect(out).toContain('error retrieving observation 5');
    expect(out).toContain('database disk image is malformed');
    expect(out).not.toContain('no observation with id'); // a broken DB must NOT read as not-found
  });

  it('a corrupt-row error (retrieve throws) also produces the error wording, not not-found', () => {
    const throwingRetrieve = ((_db: unknown, _id: number) => { throw new Error('corrupt row'); }) as typeof retrieveOriginal;
    const out = runRetrieve(['6', DB], { retrieve: throwingRetrieve });
    expect(out).toContain('error retrieving observation 6');
    expect(out).not.toContain('no observation with id');
  });
});
```

(The corrupt-row test imports `retrieveOriginal` for its type — it is already imported in this file from Task 2.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/retrieve-original.test.ts`
Expected: FAIL — `runRetrieve` not exported.

- [ ] **Step 3: Write the implementation**

Add the `getDb` import near the top of `src/retrieve-original.ts`:

```ts
import { getDb } from './db';
```

Append the CLI core and entry:

```ts
export function runRetrieve(
  args: string[],
  deps: { openDb?: (dbPath?: string) => Database; retrieve?: typeof retrieveOriginal } = {},
): string {
  const idArg = args[0];
  const id = Number(idArg);
  if (!idArg || !Number.isInteger(id) || id <= 0) {
    return 'wayfarer-retrieve: provide a positive integer observation id\n';
  }
  const openDb = deps.openDb ?? getDb;
  const retrieve = deps.retrieve ?? retrieveOriginal;
  let db: Database | undefined;
  try {
    db = openDb(args[1]);
    return formatRetrieveResult(retrieve(db, id));
  } catch (e) {
    // Real failure (DB unreadable, corrupt row): distinct from not-found so a broken
    // DB never silently reads to the model as "that observation does not exist".
    return `wayfarer-retrieve: error retrieving observation ${id}: ${e instanceof Error ? e.message : String(e)}\n`;
  } finally {
    db?.close();
  }
}

if (import.meta.main) {
  process.stdout.write(runRetrieve(process.argv.slice(2)));
  process.exit(0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/retrieve-original.test.ts`
Expected: PASS — including the thrown-DB-error test asserting the error wording AND `not.toContain('no observation with id')`.

- [ ] **Step 5: Commit**

```bash
git add src/retrieve-original.ts tests/retrieve-original.test.ts
git commit -m "feat: runRetrieve CLI core distinguishing real errors from not-found"
```

---

<!-- Task detail appended incrementally, one task per commit. -->
