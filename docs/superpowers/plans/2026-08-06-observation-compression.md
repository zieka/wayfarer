# Observation Compression at Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compress large observation fields at capture time (type-aware), storing the compressed form in the `observations` row and the full original in a TTL'd `observation_originals` table, so the DB stays small and the FTS index de-noises.

**Architecture:** A new pure module `src/compress.ts` holds the compressors, config, dispatcher, and TTL prune helper. A v4 migration adds `observation_originals`. `post-tool-use.ts` wires compression into capture (extracting file paths from the original input first, never blocking on failure). TTL pruning runs in the detached `summarize-worker` at session end.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (WAL + FTS5), `bun:test`.

## Global Constraints

- **Never block or throw in capture.** The observation INSERT always runs; the hook always returns `{ continue: true }`. On a compression throw, store `hardTruncate(...)` values and save no originals.
- **File-path extraction runs on the ORIGINAL `tool_input`, before compression** — `files_touched` must never be degraded by compression.
- **No-inflate:** if compression does not shrink a field, store the original value and mark it `compressed: false` (no originals row for that field).
- Compressed fields bounded by `MAX_COMPRESSED_CHARS`.
- Defaults: threshold `2048` (`WAYFARER_COMPRESS_THRESHOLD`); TTL `14` days (`WAYFARER_ORIGINALS_TTL_DAYS`); both parse-with-fallback on unset/invalid.
- Constants: `HEAD_LINES=40`, `TAIL_LINES=15`, `CONTEXT_LINES=10`, `SUMMARY_LINES=10`, `MAX_SIGNAL_LINES=100`, `MAX_COMPRESSED_CHARS=4096`.
- New table only (`observation_originals`, migration v4). No changes to existing columns; existing FTS tables/triggers unchanged (they index whatever the row now holds).
- `tests/db.test.ts:80` currently asserts `user_version === 3`; the v4 migration task must bump that expectation to `4`.
- Test DB convention: `/tmp/wayfarer-test-*.db`; `afterEach` unlinks `.db`, `-wal`, `-shm`.
- Neutral naming throughout — drop-markers use the `wayfarer:` prefix only; no external project name in code, comments, markers, commits, branches, or PRs.

## Tasks

1. **`compress.ts` foundations** — config (`getCompressThreshold`, `getOriginalsTtlDays`), constants, `hardTruncate`, `compressGeneric` + tests.
2. **`compress.ts` strategies + dispatcher** — `pickStrategy`, `compressLog`, `compressField`, `compressForStorage` + tests.
3. **v4 migration + `pruneOriginals`** — `observation_originals` table in `db.ts`, updated `db.test.ts` (new-table test + `user_version` → 4), `pruneOriginals` in `compress.ts` + test.
4. **Wire capture** — `post-tool-use.ts` compresses + preserves originals (injectable `compress` dep); tests incl. Constraint 1 (`files_touched` regression) and Constraint 2 (throwing-compressor failure path).
5. **Prune in worker + gate** — `summarize-worker.ts` calls `pruneOriginals`; full-suite + `bun run build` gate.

---

### Task 1: `compress.ts` foundations

**Files:**
- Create: `src/compress.ts`
- Test: `tests/compress.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `getCompressThreshold(): number`
  - `getOriginalsTtlDays(): number`
  - `hardTruncate(text: string): string`
  - `compressGeneric(text: string): string`
  - Exported consts `HEAD_LINES=40`, `TAIL_LINES=15`, `CONTEXT_LINES=10`, `SUMMARY_LINES=10`, `MAX_SIGNAL_LINES=100`, `MAX_COMPRESSED_CHARS=4096`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/compress.test.ts
import { describe, it, expect } from 'bun:test';
import {
  getCompressThreshold, getOriginalsTtlDays, hardTruncate, compressGeneric,
  MAX_COMPRESSED_CHARS, HEAD_LINES, TAIL_LINES,
} from '../src/compress';

describe('getCompressThreshold', () => {
  it('defaults to 2048 when unset', () => {
    delete process.env.WAYFARER_COMPRESS_THRESHOLD;
    expect(getCompressThreshold()).toBe(2048);
  });
  it('honors a valid override', () => {
    process.env.WAYFARER_COMPRESS_THRESHOLD = '512';
    expect(getCompressThreshold()).toBe(512);
    delete process.env.WAYFARER_COMPRESS_THRESHOLD;
  });
  it('falls back to 2048 on invalid override', () => {
    process.env.WAYFARER_COMPRESS_THRESHOLD = 'nope';
    expect(getCompressThreshold()).toBe(2048);
    delete process.env.WAYFARER_COMPRESS_THRESHOLD;
  });
});

describe('getOriginalsTtlDays', () => {
  it('defaults to 14 when unset', () => {
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS;
    expect(getOriginalsTtlDays()).toBe(14);
  });
  it('honors a valid override', () => {
    process.env.WAYFARER_ORIGINALS_TTL_DAYS = '7';
    expect(getOriginalsTtlDays()).toBe(7);
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS;
  });
  it('falls back to 14 on invalid override', () => {
    process.env.WAYFARER_ORIGINALS_TTL_DAYS = 'x';
    expect(getOriginalsTtlDays()).toBe(14);
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS;
  });
});

describe('hardTruncate', () => {
  it('returns text unchanged when within the cap', () => {
    const s = 'short';
    expect(hardTruncate(s)).toBe(s);
  });
  it('slices to the cap and appends a marker when over', () => {
    const s = 'x'.repeat(MAX_COMPRESSED_CHARS + 500);
    const out = hardTruncate(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain('[wayfarer: dropped');
    expect(out.startsWith('x'.repeat(100))).toBe(true);
  });
});

describe('compressGeneric', () => {
  it('keeps head + tail lines and inserts a dropped marker', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const out = compressGeneric(lines.join('\n'));
    expect(out).toContain('line 0');
    expect(out).toContain('line 299');
    expect(out).toContain('[wayfarer: dropped');
    expect(out.length).toBeLessThan(lines.join('\n').length);
    // a middle line is gone
    expect(out).not.toContain('line 150');
  });
  it('char-slices a single giant line via hardTruncate', () => {
    const s = 'y'.repeat(MAX_COMPRESSED_CHARS * 2);
    const out = compressGeneric(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain('[wayfarer: dropped');
  });
  it('preserves both head and tail when combined head+tail exceeds the cap', () => {
    // Long lines so head+tail alone blows past MAX_COMPRESSED_CHARS.
    const line = (tag: string, i: number) => `${tag}-${i}-` + 'x'.repeat(120);
    const head = Array.from({ length: HEAD_LINES }, (_, i) => line('HEAD', i));
    const mid = Array.from({ length: 50 }, (_, i) => line('MID', i));
    const tail = Array.from({ length: TAIL_LINES }, (_, i) => line('TAIL', i));
    const out = compressGeneric([...head, ...mid, ...tail].join('\n'));
    expect(out.length).toBeLessThanOrEqual(MAX_COMPRESSED_CHARS + 80); // cap + marker slack
    expect(out).toContain('HEAD-0-');                 // head survived
    expect(out).toContain(`TAIL-${TAIL_LINES - 1}-`); // last tail line survived
    expect(out).toContain('[wayfarer: dropped');
    expect(out).not.toContain('MID-25-');             // middle dropped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compress.test.ts`
Expected: FAIL — cannot resolve `../src/compress` / exports undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compress.ts
const DEFAULT_COMPRESS_THRESHOLD = 2048;
const DEFAULT_ORIGINALS_TTL_DAYS = 14;

export const HEAD_LINES = 40;
export const TAIL_LINES = 15;
export const CONTEXT_LINES = 10;
export const SUMMARY_LINES = 10;
export const MAX_SIGNAL_LINES = 100;
export const MAX_COMPRESSED_CHARS = 4096;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getCompressThreshold(): number {
  return envInt('WAYFARER_COMPRESS_THRESHOLD', DEFAULT_COMPRESS_THRESHOLD);
}

export function getOriginalsTtlDays(): number {
  return envInt('WAYFARER_ORIGINALS_TTL_DAYS', DEFAULT_ORIGINALS_TTL_DAYS);
}

export function hardTruncate(text: string): string {
  if (text.length <= MAX_COMPRESSED_CHARS) return text;
  const dropped = text.length - MAX_COMPRESSED_CHARS;
  return text.slice(0, MAX_COMPRESSED_CHARS) + `\n… [wayfarer: dropped ${dropped} chars] …`;
}

export function compressGeneric(text: string): string {
  const lines = text.split('\n');
  if (lines.length > HEAD_LINES + TAIL_LINES + 1) {
    const head = lines.slice(0, HEAD_LINES).join('\n');
    const tail = lines.slice(lines.length - TAIL_LINES).join('\n');
    const droppedLines = lines.length - HEAD_LINES - TAIL_LINES;
    const marker = `… [wayfarer: dropped ${droppedLines} lines] …`;
    const full = `${head}\n${marker}\n${tail}`;
    if (full.length <= MAX_COMPRESSED_CHARS) return full;
    // Over cap: budget head and tail independently so BOTH survive (front of
    // head, end of tail). Never front-slice the whole thing — that drops the tail.
    const budget = Math.max(0, MAX_COMPRESSED_CHARS - marker.length - 2);
    const half = Math.floor(budget / 2);
    const headPart = head.length > half ? head.slice(0, half) : head;
    const tailPart = tail.length > half ? tail.slice(tail.length - half) : tail;
    return `${headPart}\n${marker}\n${tailPart}`;
  }
  // Few lines (e.g. one giant line) but over threshold by char count.
  return hardTruncate(text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compress.test.ts`
Expected: PASS (all Task 1 cases).

- [ ] **Step 5: Commit**

```bash
git add src/compress.ts tests/compress.test.ts
git commit -m "feat: compression config, hardTruncate, and generic compressor"
```

---

### Task 2: `compress.ts` strategies + dispatcher

**Files:**
- Modify: `src/compress.ts`
- Test: `tests/compress.test.ts`

**Interfaces:**
- Consumes: `getCompressThreshold`, `hardTruncate`, `compressGeneric`, and the line-count consts from Task 1.
- Produces:
  - `pickStrategy(toolName: string, text: string): 'log' | 'generic'`
  - `compressLog(text: string): string`
  - `compressField(toolName: string, text: string): { text: string; compressed: boolean }`
  - `compressForStorage(toolName: string, toolInput: string, toolOutput: string): { input: { text: string; compressed: boolean }; output: { text: string; compressed: boolean } }`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/compress.test.ts
import { pickStrategy, compressLog, compressField, compressForStorage } from '../src/compress';

describe('pickStrategy', () => {
  it('routes Bash to the log strategy', () => {
    expect(pickStrategy('Bash', 'plain output')).toBe('log');
  });
  it('routes text with a log signal to the log strategy', () => {
    expect(pickStrategy('Read', 'line one\nERROR: boom\nline three')).toBe('log');
  });
  it('routes plain prose to the generic strategy', () => {
    expect(pickStrategy('Read', 'just some ordinary file contents here')).toBe('generic');
  });
  it('routes keyword-free stack-frame text to the log strategy', () => {
    const trace = 'line one\n    at foo (bar.ts:1)\n    at baz (bar.ts:2)\nline four';
    expect(pickStrategy('Read', trace)).toBe('log');
  });
});

describe('compressLog', () => {
  it('preserves an error line buried in the middle and drops low-signal lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `info line ${i}`);
    lines[50] = 'ERROR: something failed';
    const input = lines.join('\n');
    const out = compressLog(input);
    expect(out).toContain('ERROR: something failed');
    expect(out).toContain('[wayfarer: dropped');
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain('info line 0');   // context head kept
    expect(out).toContain('info line 99');  // summary tail kept
    expect(out).not.toContain('info line 40'); // low-signal middle dropped
  });
  it('preserves contiguous stack-frame lines', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `noise ${i}`);
    lines[40] = 'Traceback (most recent call last):';
    lines[41] = '    at foo (bar.ts:1)';
    lines[42] = '    at baz (bar.ts:2)';
    const out = compressLog(lines.join('\n'));
    expect(out).toContain('Traceback (most recent call last):');
    expect(out).toContain('    at foo (bar.ts:1)');
    expect(out).toContain('    at baz (bar.ts:2)');
  });
  it('preserves the last line even when the compressed result exceeds the cap', () => {
    // Enough signal volume to push the assembled result past MAX_COMPRESSED_CHARS.
    const lines = Array.from({ length: 300 }, (_, i) => `ERROR line ${i} ` + 'z'.repeat(40));
    lines[lines.length - 1] = 'FINAL-TAIL-LINE-MARKER';
    const out = compressLog(lines.join('\n'));
    expect(out.length).toBeLessThanOrEqual(MAX_COMPRESSED_CHARS + 80); // cap + marker slack
    expect(out).toContain('FINAL-TAIL-LINE-MARKER'); // tail survives
    expect(out).toContain('ERROR line 0');           // head survives
  });
});

describe('compressField', () => {
  it('passes through text at or under the threshold unchanged', () => {
    const r = compressField('Read', 'small');
    expect(r).toEqual({ text: 'small', compressed: false });
  });
  it('compresses a large multi-line field', () => {
    const input = Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n');
    const r = compressField('Read', input);
    expect(r.compressed).toBe(true);
    expect(r.text.length).toBeLessThan(input.length);
  });
  it('does not inflate: over-threshold but incompressible stays original', () => {
    // one giant line, length between threshold (2048) and MAX_COMPRESSED_CHARS (4096)
    const input = 'z'.repeat(3000);
    const r = compressField('Read', input);
    expect(r).toEqual({ text: input, compressed: false });
  });
});

describe('compressForStorage', () => {
  it('returns compressed flags for both fields', () => {
    const bigLog = Array.from({ length: 400 }, (_, i) => `ERROR line ${i}`).join('\n');
    const r = compressForStorage('Bash', 'small input', bigLog);
    expect(r.input.compressed).toBe(false);
    expect(r.output.compressed).toBe(true);
    expect(r.output.text.length).toBeLessThan(bigLog.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compress.test.ts`
Expected: FAIL — `pickStrategy` / `compressLog` / `compressField` / `compressForStorage` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/compress.ts
const LOG_SIGNAL_RE = /\b(ERROR|WARN(?:ING)?|FAIL(?:ED|URE)?|Traceback|Exception|panic)\b/;
const STACK_FRAME_RE = /^\s+at\s+/m; // `m` so it matches a frame on any line of a multi-line blob

export function pickStrategy(toolName: string, text: string): 'log' | 'generic' {
  if (toolName === 'Bash' || toolName === 'BashOutput') return 'log';
  if (LOG_SIGNAL_RE.test(text) || STACK_FRAME_RE.test(text)) return 'log';
  return 'generic';
}

function isSignal(line: string): boolean {
  return LOG_SIGNAL_RE.test(line) || STACK_FRAME_RE.test(line);
}

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
      if (droppedRun > 0) { out.push(`… [wayfarer: dropped ${droppedRun} lines] …`); droppedRun = 0; }
      out.push(lines[i]);
    } else {
      droppedRun++;
    }
  }
  if (droppedRun > 0) out.push(`… [wayfarer: dropped ${droppedRun} lines] …`);
  const result = out.join('\n');
  if (result.length <= MAX_COMPRESSED_CHARS) return result;
  // Over cap: budget head and tail of the assembled result so BOTH survive.
  // Never front-slice the whole thing — that drops the guaranteed last SUMMARY_LINES.
  const sizeMarker = '… [wayfarer: dropped middle for size] …';
  const budget = Math.max(0, MAX_COMPRESSED_CHARS - sizeMarker.length - 2);
  const half = Math.floor(budget / 2);
  return `${result.slice(0, half)}\n${sizeMarker}\n${result.slice(result.length - half)}`;
}

export function compressField(toolName: string, text: string): { text: string; compressed: boolean } {
  if (text.length <= getCompressThreshold()) return { text, compressed: false };
  try {
    const strategy = pickStrategy(toolName, text);
    const out = strategy === 'log' ? compressLog(text) : compressGeneric(text);
    if (out.length >= text.length) return { text, compressed: false };
    return { text: out, compressed: true };
  } catch {
    return { text: hardTruncate(text), compressed: true };
  }
}

export function compressForStorage(
  toolName: string,
  toolInput: string,
  toolOutput: string,
): { input: { text: string; compressed: boolean }; output: { text: string; compressed: boolean } } {
  return {
    input: compressField(toolName, toolInput),
    output: compressField(toolName, toolOutput),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compress.test.ts`
Expected: PASS (Task 1 + Task 2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/compress.ts tests/compress.test.ts
git commit -m "feat: log strategy, field compressor, and storage dispatcher"
```

---

### Task 3: v4 migration + `pruneOriginals`

**Files:**
- Modify: `src/db.ts` (add the v4 migration block)
- Modify: `tests/db.test.ts` (new-table test; bump `user_version` assertion 3 → 4)
- Modify: `src/compress.ts` (add `pruneOriginals`)
- Test: `tests/compress.test.ts` (prune test)

**Interfaces:**
- Consumes: `getDb` (`src/db.ts`), `getOriginalsTtlDays` (Task 1).
- Produces: `pruneOriginals(db: Database, nowSeconds: number): number` (returns rows deleted).
- Note: `import type { Database } from 'bun:sqlite'` in `compress.ts` for the param type.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/db.test.ts — ADD this test inside describe('getDb', ...)
  it('creates observation_originals table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observation_originals'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('observation_originals');
    db.close();
  });
```

```ts
// tests/db.test.ts — CHANGE the existing 'runs migrations idempotently' expectation
// from:  expect(version.user_version).toBe(3);
//   to:  expect(version.user_version).toBe(4);
```

```ts
// tests/compress.test.ts — append
import { unlinkSync } from 'fs';
import { getDb } from '../src/db';
import { pruneOriginals } from '../src/compress';

const PRUNE_DB = '/tmp/wayfarer-test-prune.db';

function cleanupPrune() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(PRUNE_DB + suffix); } catch {}
  }
}

describe('pruneOriginals', () => {
  afterEach(cleanupPrune);

  it('deletes originals older than the TTL and keeps recent ones', () => {
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS; // default 14 days
    const db = getDb(PRUNE_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO sessions (session_id, project, started_at) VALUES (?,?,?)', ['s1', '/p', now]);
    // two observations (FK targets for observation_originals)
    const oldObs = db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['s1', '/p', 'Bash', 'in', 'out', null, now - 40 * 86400],
    ).lastInsertRowid;
    const newObs = db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['s1', '/p', 'Bash', 'in', 'out', null, now],
    ).lastInsertRowid;
    db.run(
      'INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at) VALUES (?,?,?,?)',
      [oldObs, null, 'old full output', now - 40 * 86400],
    );
    db.run(
      'INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at) VALUES (?,?,?,?)',
      [newObs, null, 'new full output', now],
    );

    const deleted = pruneOriginals(db, now);
    expect(deleted).toBe(1);

    const remaining = db.query('SELECT observation_id FROM observation_originals').all() as Array<{ observation_id: number }>;
    expect(remaining).toHaveLength(1);
    expect(Number(remaining[0].observation_id)).toBe(Number(newObs));
    db.close();
  });
});
```

`afterEach` is already imported in `tests/compress.test.ts` — if not, add it to the existing `bun:test` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts tests/compress.test.ts`
Expected: FAIL — `observation_originals` table missing (migration not written), `user_version` still 3, `pruneOriginals` not exported.

- [ ] **Step 3: Write the migration**

```ts
// src/db.ts — add after the `if (version < 3) { ... }` block, before the closing brace of migrate()
  if (version < 4) {
    db.run('BEGIN');
    db.run(`
      CREATE TABLE IF NOT EXISTS observation_originals (
        observation_id INTEGER PRIMARY KEY,
        tool_input_full TEXT,
        tool_output_full TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_originals_created ON observation_originals(created_at)');
    db.run('PRAGMA user_version = 4');
    db.run('COMMIT');
  }
```

- [ ] **Step 4: Write `pruneOriginals`**

```ts
// src/compress.ts — add at the top with the other imports
import type { Database } from 'bun:sqlite';

// src/compress.ts — append
export function pruneOriginals(db: Database, nowSeconds: number): number {
  const cutoff = nowSeconds - getOriginalsTtlDays() * 86400;
  const result = db.run('DELETE FROM observation_originals WHERE created_at < ?', [cutoff]);
  return result.changes;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/db.test.ts tests/compress.test.ts`
Expected: PASS (new table test, `user_version === 4`, prune test, and all Task 1–2 cases).

- [ ] **Step 6: Commit**

```bash
git add src/db.ts tests/db.test.ts src/compress.ts tests/compress.test.ts
git commit -m "feat: observation_originals table (v4) and TTL prune"
```

---

### Task 4: Wire capture in `post-tool-use.ts`

**Files:**
- Modify: `src/hooks/post-tool-use.ts`
- Test: `tests/hooks/post-tool-use.test.ts`

**Interfaces:**
- Consumes: `compressForStorage`, `hardTruncate` (`src/compress.ts`); `extractFilePaths` (`src/files.ts`); `getDb`.
- Produces: `handlePostToolUse(input, dbPath?, deps?: { compress?: typeof compressForStorage }): HookResponse` (adds an optional injectable `compress` dep; return shape unchanged).

**Behavior:** extract file paths from the ORIGINAL `tool_input` first; compute stored values via `compress` inside a try/catch (on throw → `hardTruncate` both fields, save no originals); ALWAYS insert the observation; if either field was compressed, insert one `observation_originals` row keyed by `lastInsertRowid`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/hooks/post-tool-use.test.ts — append these tests inside describe('handlePostToolUse', ...)

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/hooks/post-tool-use.test.ts`
Expected: FAIL — no compression yet (large output stored verbatim, no `observation_originals` rows, `deps` arg unsupported).

- [ ] **Step 3: Write the implementation**

```ts
// src/hooks/post-tool-use.ts
import { readStdin } from '../stdin';
import { getDb } from '../db';
import { extractFilePaths } from '../files';
import { compressForStorage, hardTruncate } from '../compress';
import type { HookResponse } from './user-prompt-submit';

export function handlePostToolUse(
  input: Record<string, unknown>,
  dbPath?: string,
  deps: { compress?: typeof compressForStorage } = {},
): HookResponse {
  const compress = deps.compress ?? compressForStorage;
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;
  const project = (input.cwd ?? process.cwd()) as string;
  const toolName = (input.tool_name ?? 'unknown') as string;
  const toolInput = typeof input.tool_input === 'string'
    ? input.tool_input
    : JSON.stringify(input.tool_input ?? '');
  const toolOutput = typeof input.tool_response === 'string'
    ? input.tool_response
    : JSON.stringify(input.tool_response ?? '');

  // Constraint 1: extract file paths from the ORIGINAL input, before compression.
  const filesTouched = extractFilePaths(toolInput);

  // Constraint 2: compression must never block capture.
  let storedInput = toolInput;
  let storedOutput = toolOutput;
  let originalInput: string | null = null;
  let originalOutput: string | null = null;
  try {
    const { input: ci, output: co } = compress(toolName, toolInput, toolOutput);
    storedInput = ci.text;
    storedOutput = co.text;
    originalInput = ci.compressed ? toolInput : null;
    originalOutput = co.compressed ? toolOutput : null;
  } catch (e) {
    storedInput = hardTruncate(toolInput);
    storedOutput = hardTruncate(toolOutput);
    originalInput = null;
    originalOutput = null;
    console.error(`wayfarer: compression failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const db = getDb(dbPath);
  try {
    db.run(
      'INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?, ?, ?)',
      [sessionId, project, now],
    );

    const res = db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, project, toolName, storedInput, storedOutput, filesTouched, now],
    );

    if (originalInput !== null || originalOutput !== null) {
      db.run(
        `INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at)
         VALUES (?, ?, ?, ?)`,
        [res.lastInsertRowid, originalInput, originalOutput, now],
      );
    }
  } finally {
    db.close();
  }

  return { continue: true };
}

if (import.meta.main) {
  try {
    const input = await readStdin();
    if (input) {
      const result = handlePostToolUse(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: post-tool-use failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hooks/post-tool-use.test.ts`
Expected: PASS (the four new tests plus the pre-existing ones — small outputs still store verbatim).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/post-tool-use.ts tests/hooks/post-tool-use.test.ts
git commit -m "feat: compress observations at capture, preserve originals"
```

---

### Task 5: Prune in the worker + full-suite/build gate

**Files:**
- Modify: `src/summarize-worker.ts` (call `pruneOriginals`)

**Interfaces:**
- Consumes: `pruneOriginals` (`src/compress.ts`, Task 3).
- Produces: nothing new.

**Note on testing:** the worker is a detached script that spawns the external `claude` CLI, so it is not unit-tested here. `pruneOriginals` itself is unit-tested in Task 3; this task's verification is the full-suite + build gate below. The wiring is a single guarded call so a prune failure never affects the summary write.

- [ ] **Step 1: Add the import**

```ts
// src/summarize-worker.ts — add with the existing top-of-file imports
import { pruneOriginals } from './compress';
```

- [ ] **Step 2: Prune right after opening the DB (decoupled from summarization)**

In `src/summarize-worker.ts`, place the prune call immediately AFTER `const db = getDb(dbPath);` and BEFORE the `if (!session)` / `if (observations.length === 0)` early-exit checks. Pruning must NOT depend on summarization succeeding: the early exits and any `claude -p` failure would otherwise bypass it (via the outer `catch` → `process.exit(0)`), letting the originals table grow unbounded under a persistent summarizer failure. Running it first — before the session/observations checks and before the `claude -p` await — guarantees TTL cleanup on every path that obtains a DB handle. It stays in its own try/catch so a prune failure never affects the summary write.

```ts
  const db = getDb(dbPath);

  // TTL-prune expired observation originals FIRST, so cleanup runs regardless of
  // whether summarization succeeds (early exits and claude -p failures skip the rest).
  try {
    pruneOriginals(db, Math.floor(Date.now() / 1000));
  } catch (e) {
    console.error(`wayfarer: prune failed: ${e instanceof Error ? e.message : String(e)}`);
  }
```

Do not add a second prune call before `db.close()`.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS — the entire suite is green (Task 1–4 tests plus all pre-existing tests). Note: Bun v1.3.x may print a C++ panic AFTER the summary line with exit code 0 — that is a known upstream shutdown bug; judge success by the `N pass, 0 fail` line, not the panic.

- [ ] **Step 4: Build**

Run: `bun run build`
Expected: `Built 4 hooks + summarize-worker to plugin/scripts/` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/summarize-worker.ts
git commit -m "feat: TTL-prune observation originals in the background worker"
```

---

## Self-Review

**Spec coverage:**
- Preserve originals with a TTL → Task 3 (`observation_originals` + `pruneOriginals`) + Task 5 (wired in worker). ✓
- Lean compressors (generic + log-aware) → Tasks 1–2. ✓
- Approach A: `src/compress.ts` module + v4 migration; capture wires in; prune off the hot path → Tasks 1–5. ✓
- 2KB threshold / 14-day TTL, env-overridable, parse-with-fallback → Task 1 (`getCompressThreshold`, `getOriginalsTtlDays`). ✓
- Never block/throw in capture; failure → hardTruncate + no originals → Task 4 (try/catch) + Constraint 2 test. ✓
- File extraction on original before compression → Task 4 + Constraint 1 test. ✓
- No-inflate → Task 2 (`compressField`) + its test. ✓
- Bounded by `MAX_COMPRESSED_CHARS` → Tasks 1–2 (`hardTruncate` tail-caps every path). ✓
- New table only; existing columns/FTS untouched → Task 3 (additive migration). ✓
- `db.test.ts` `user_version` 3 → 4 → Task 3. ✓

**Placeholder scan:** none — every code step has full code; every run step has an exact command + expected result.

**Type consistency:** `compressForStorage` signature is identical in Tasks 2 and 4 (`(toolName, toolInput, toolOutput) → { input:{text,compressed}, output:{text,compressed} }`); the Task 4 injected `deps.compress` is typed `typeof compressForStorage`. `pruneOriginals(db, nowSeconds): number` is identical in Tasks 3 and 5. `hardTruncate(text): string` used in Tasks 1, 2, 4 consistently. `res.lastInsertRowid` (bun:sqlite `db.run` return) used in Task 4 matches the prune test's `.lastInsertRowid` usage in Task 3.

