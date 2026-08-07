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

<!-- Task detail appended incrementally, one task per commit. -->
