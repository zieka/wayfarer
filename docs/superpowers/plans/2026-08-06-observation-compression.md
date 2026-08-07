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
    const head = lines.slice(0, HEAD_LINES);
    const tail = lines.slice(lines.length - TAIL_LINES);
    const droppedLines = lines.length - HEAD_LINES - TAIL_LINES;
    const out = [...head, `… [wayfarer: dropped ${droppedLines} lines] …`, ...tail].join('\n');
    return out.length > MAX_COMPRESSED_CHARS ? hardTruncate(out) : out;
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
const STACK_FRAME_RE = /^\s+at\s+/;

export function pickStrategy(toolName: string, text: string): 'log' | 'generic' {
  if (toolName === 'Bash' || toolName === 'BashOutput') return 'log';
  if (LOG_SIGNAL_RE.test(text)) return 'log';
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
    if (isSignal(lines[i])) { keep[i] = true; signalCount++; }
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
  return result.length > MAX_COMPRESSED_CHARS ? hardTruncate(result) : result;
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

<!-- Task detail appended incrementally, one task per commit. -->
