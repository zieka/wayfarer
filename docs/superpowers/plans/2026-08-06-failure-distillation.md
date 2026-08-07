# Failure Distillation (+ type-check gate) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distill "tool error → later same-target success" into terse, deduped **corrections** that inject proactively as a capped "Known pitfalls" section in future sessions; and add the repo's first automated gate — a hard-failing `tsc --noEmit` wired into `bun run build`.

**Architecture:** `is_error` captured at PostToolUse into a new `observations` column (schema v5); a new pure, testable `src/distill.ts` (hand-coded error→recovery pairing gating an injected LLM `phrase` step) run as a guarded, decoupled step in the summarize-worker; corrections stored in a new project-scoped table and injected at the top of the SessionStart primer. The type-check gate lands FIRST so every later task is type-checked.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (WAL + FTS5), `bun:test`, esbuild, `tsc --noEmit`, Claude Code plugin skills/hooks.

## Global Constraints

- **No-pair path is the most-guarded behavior:** a session with errors but NO error→recovery pair must emit ZERO corrections AND must NOT invoke the `phrase` LLM function at all (`distillCorrections` returns before `phrase` is referenced). A fabricated correction poisons future sessions persistently. This is asserted with a `phrase` **spy**.
- **Distillation is decoupled:** it runs in its own `try/catch` in the worker, BEFORE summary generation, so a summary `claude -p` failure cannot skip it — and its own failure cannot affect the summary or the prune.
- **Corrections outlive sessions:** `source_session_id` is provenance only, NO cascading FK.
- **Never block/throw:** `is_error` capture failure → default `0`, capture proceeds; pitfalls query failure → omit the section, primer still returns summaries; distillation failure → no corrections, worker exits 0.
- **Dedup:** `content_hash = sha256(normalize(text)).slice(0,16)`, `normalize` = trim + lowercase + collapse internal whitespace; table has `UNIQUE(project, content_hash)`, insert via `INSERT OR IGNORE`. Dedup must not swallow a genuinely different correction.
- **Pitfalls injection:** `PITFALLS_BUDGET = 400` tokens, `PITFALLS_CAP = 5`; `chars/4` estimate (reuse `estimateTokens`); a `## Known pitfalls in this project` section at the TOP of the SessionStart primer. Summary injection path otherwise unchanged (zero added tokens there).
- **Build hard-fails on type errors:** `scripts/build.ts` runs `tsc --noEmit` first and exits non-zero WITHOUT building on any type error.
- Additive migration only (v5): new `observations.is_error` column + new `corrections` table. Existing FTS tables/triggers untouched.
- `normalizeTarget`: parse `tool_input` JSON → `.command` (Bash) / `.file_path` (file tools); else first `files_touched` path; else raw `tool_input`; then trim + collapse whitespace. Pairing also requires `tool_name` equality.
- Neutral naming throughout (`wayfarer:` markers, `Known pitfalls…` heading); no external project name anywhere.
- Test DB convention `/tmp/wayfarer-test-*.db`; `afterEach` unlinks `.db`/`-wal`/`-shm`.
- `bun test` prints a Bun C++ panic AFTER the `N pass, 0 fail` summary (nonzero exit) — known upstream bug; judge tests by the pass/fail line, not the exit code.

## Tasks

1. **Type-check gate** — add `typescript` + `bun-types` devDeps and a `typecheck` script; configure `tsconfig.json` so `tsc --noEmit` runs clean on the current tree (fix surfaced errors); make `bun run build` run `tsc --noEmit` first and hard-fail. Every later task runs `bun run typecheck` in its gate.
2. **Schema v5** — `observations.is_error` column + `corrections` table (`UNIQUE(project, content_hash)`, no cascading FK) + index; update `tests/db.test.ts` (new column, new table, `user_version` → 5).
3. **Capture `is_error`** — `post-tool-use.ts` derives `is_error` (payload flag → heuristic fallback → `0`) and stores it; tests for errored/normal/never-throws.
4. **`src/distill.ts` core** — `normalizeTarget`, `detectErrorRecoveryPairs`, `correctionHash`, `distillCorrections(db, sessionId, project, phrase)`; tests incl. the NAMED no-pair `phrase`-spy guard and dedup-both-directions.
5. **Wire distillation into the worker** — guarded, decoupled step in `summarize-worker.ts` (before summary generation) with a local `claude -p` phrase fn.
6. **Pitfalls injection + final gate** — `pitfallsForProject` + primer section in `src/retrieve.ts`; `tests/retrieve.test.ts`; full-suite + `bun run typecheck` + `bun run build` gate.

---

### Task 1: Type-check gate

**Files:**
- Modify: `package.json` (devDeps + `typecheck` script), `tsconfig.json` (include tests/scripts, drop `rootDir`), `scripts/build.ts` (run `tsc --noEmit` first, hard-fail)
- Possibly add: a minimal ambient declaration file if a dependency lacks types (see Step 4)

**Interfaces:**
- Consumes: nothing.
- Produces: a `bun run typecheck` script (`tsc --noEmit`) that every later task runs in its gate, and a `bun run build` that hard-fails on type errors.

This task is infra, not TDD-shaped: the "test" is that `tsc --noEmit` runs clean on the whole tree AND that a deliberately-introduced type error makes `bun run build` exit non-zero without building (Step 6).

- [ ] **Step 1: Add devDependencies**

Run: `bun add -d typescript bun-types`
Expected: `typescript` and `bun-types` appear under `devDependencies` in `package.json`; `bun.lock` updates.

- [ ] **Step 2: Add the `typecheck` script**

In `package.json` `scripts`, add:
```json
    "typecheck": "tsc --noEmit",
```
(Keep the existing `build`/`test`/`dev:install` scripts.)

- [ ] **Step 3: Broaden `tsconfig.json` to cover tests + scripts**

The current config only checks `src` and sets `rootDir: "src"` (which conflicts with including other dirs). Since the build uses esbuild — not `tsc` — for output, `rootDir`/`outDir` are irrelevant to `--noEmit`. Change `tsconfig.json` to:
- Remove the `"rootDir": "src"` line (and the `"outDir": "dist"` line — unused under `--noEmit`).
- Set `"include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]`.
- Keep `"strict": true`, `"types": ["bun-types"]`, `"skipLibCheck": true`, and the rest.

Result `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "types": ["bun-types"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
  "exclude": ["node_modules", "dist", "plugin"]
}
```

- [ ] **Step 4: Run the type check and fix everything it surfaces**

Run: `bun run typecheck`
Fix every reported error until it exits 0. Likely cases and how to handle them:
- **A dependency without bundled types** (most likely `fastembed`, imported in `src/embed.ts`) → TS7016 "could not find a declaration file". If `fastembed` genuinely ships no types, add a minimal ambient declaration `src/types/fastembed.d.ts` with just what's used, e.g.:
  ```ts
  declare module 'fastembed' {
    export enum EmbeddingModel { BGESmallENV15 = 'BGESmallENV15' }
    export class FlagEmbedding {
      static init(opts: { model: EmbeddingModel; cacheDir?: string }): Promise<FlagEmbedding>;
      embed(texts: string[]): AsyncIterable<number[][]>;
    }
  }
  ```
  (Adjust to match the real usage in `src/embed.ts`. If `fastembed` DOES ship types, skip this.)
- **Real type errors in existing code** (e.g. a missing field on an object literal like the feature-#3 `#undefined` fixture, `possibly-undefined` access, `bigint` vs `number` from `lastInsertRowid`) → fix them properly (add the field, guard the access, `Number(...)` the id). Do NOT silence with `any`/`@ts-ignore` unless it's a genuine third-party gap.

Re-run `bun run typecheck` until it prints no errors and exits 0.

- [ ] **Step 5: Wire the gate into the build (hard-fail)**

At the very top of `scripts/build.ts` (before `mkdirSync`), add:
```ts
// Type-check gate: the build is this repo's only automated gate, so hard-fail on any type error.
const typecheck = Bun.spawnSync(['bunx', 'tsc', '--noEmit'], { stdout: 'inherit', stderr: 'inherit' });
if (typecheck.exitCode !== 0) {
  console.error('Type check failed (tsc --noEmit) — aborting build.');
  process.exit(typecheck.exitCode || 1);
}
```
Leave the rest of `build.ts` unchanged.

- [ ] **Step 6: Verify the gate builds clean AND bites**

Run: `bun run build`
Expected: type check passes, then `Built 4 hooks + summarize-worker + retrieve to plugin/scripts/`, exit 0.

Then prove the gate fails on a real type error: temporarily add an obviously-wrong line to `src/db.ts` (e.g. `const _x: number = "nope";`), run `bun run build`, and confirm it prints the type-check failure and exits non-zero **without** the "Built …" line. Then remove that line and re-run `bun run build` to confirm it's green again.

- [ ] **Step 7: Full suite + commit**

Run: `bun test`
Expected: `N pass, 0 fail` (ignore the trailing Bun panic/exit-133 per Global Constraints).

```bash
git add package.json bun.lock tsconfig.json scripts/build.ts
# include the ambient declaration if you added one:
# git add src/types/fastembed.d.ts
# include any source/test files you fixed to make tsc clean
git add -A
git commit -m "build: hard-failing tsc --noEmit type-check gate"
```

---

### Task 2: Schema v5 (`is_error` column + `corrections` table)

**Files:**
- Modify: `src/db.ts` (add the `version < 5` migration block)
- Modify: `tests/db.test.ts` (new-column + new-table tests; bump `user_version` 4 → 5)

**Interfaces:**
- Consumes: `getDb` (`src/db.ts`).
- Produces: `observations.is_error INTEGER NOT NULL DEFAULT 0`; a `corrections` table with `UNIQUE(project, content_hash)` and `idx_corrections_project`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/db.test.ts — ADD these tests inside describe('getDb', ...)
  it('adds is_error column to observations', () => {
    const db = getDb(TEST_DB);
    const cols = db.query("PRAGMA table_info(observations)").all() as Array<{ name: string; dflt_value: string | null }>;
    const isError = cols.find((c) => c.name === 'is_error');
    expect(isError).toBeDefined();
    expect(isError!.dflt_value).toBe('0');
    db.close();
  });

  it('creates corrections table', () => {
    const db = getDb(TEST_DB);
    const t = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='corrections'"
    ).get() as { name: string } | null;
    expect(t?.name).toBe('corrections');
    db.close();
  });

  it('enforces UNIQUE(project, content_hash) on corrections', () => {
    const db = getDb(TEST_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?,?,?,?,?)', ['/p', 'a', 'h1', 's1', now]);
    const dup = db.run('INSERT OR IGNORE INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?,?,?,?,?)', ['/p', 'a again', 'h1', 's2', now]);
    expect(dup.changes).toBe(0); // same (project, content_hash) ignored
    const diff = db.run('INSERT OR IGNORE INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?,?,?,?,?)', ['/p', 'b', 'h2', 's3', now]);
    expect(diff.changes).toBe(1); // different hash inserts
    db.close();
  });
```

```ts
// tests/db.test.ts — CHANGE the existing 'runs migrations idempotently' assertion
// from:  expect(version.user_version).toBe(4);
//   to:  expect(version.user_version).toBe(5);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts`
Expected: FAIL — no `is_error` column, no `corrections` table, `user_version` still 4.

- [ ] **Step 3: Write the migration**

```ts
// src/db.ts — add after the `if (version < 4) { ... }` block, before migrate()'s closing brace
  if (version < 5) {
    db.run('BEGIN');
    db.run('ALTER TABLE observations ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0');
    db.run(`
      CREATE TABLE IF NOT EXISTS corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        correction TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_session_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(project, content_hash)
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_corrections_project ON corrections(project, created_at DESC)');
    db.run('PRAGMA user_version = 5');
    db.run('COMMIT');
  }
```

Notes:
- `ALTER TABLE … ADD COLUMN` with `NOT NULL DEFAULT 0` is valid in SQLite and backfills existing rows with `0`.
- `source_session_id` has NO foreign key — corrections must outlive their originating session (a pruned/deleted session must not cascade-delete corrections).
- The `observations_fts` external-content triggers reference named columns only, so the new `is_error` column does not affect FTS.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/db.test.ts`
Expected: PASS — new column (default `0`), `corrections` table, `UNIQUE` behavior, and `user_version === 5`.

- [ ] **Step 5: Type-check + commit**

Run: `bun run typecheck`
Expected: exits 0 (no type errors introduced).

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: schema v5 — observations.is_error and corrections table"
```

---

### Task 3: Capture `is_error` at PostToolUse

**Files:**
- Modify: `src/hooks/post-tool-use.ts`
- Test: `tests/hooks/post-tool-use.test.ts`

**Interfaces:**
- Consumes: the `observations.is_error` column (Task 2).
- Produces: a private `detectIsError(input, toolOutput): number` and an `is_error` value written on every observation. No new exports.
- Behavior: prefer the payload flag (`tool_response.is_error` when `tool_response` is an object), else a conservative output-text heuristic, else `0`; must never throw.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/hooks/post-tool-use.test.ts — append inside describe('handlePostToolUse', ...)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/hooks/post-tool-use.test.ts`
Expected: FAIL — `is_error` is not captured yet (column exists from Task 2 but the INSERT doesn't set it, so it defaults to 0 and the two `is_error=1` tests fail).

- [ ] **Step 3: Write the implementation**

Add near the top of `src/hooks/post-tool-use.ts` (after the imports):
```ts
// Conservative fallback when the payload carries no explicit error flag.
const ERROR_TEXT_RE = /\b(error|exception|failed|failure|traceback|panic|not found|no such file|permission denied|command not found)\b/i;

function detectIsError(input: Record<string, unknown>, toolOutput: string): number {
  try {
    const resp = input.tool_response;
    if (resp && typeof resp === 'object' && 'is_error' in resp) {
      return (resp as { is_error?: unknown }).is_error ? 1 : 0;
    }
    return ERROR_TEXT_RE.test(toolOutput) ? 1 : 0;
  } catch {
    return 0; // detection must never block capture
  }
}
```

Compute it from the RAW `toolOutput` (before compression) — add after the `toolOutput` assignment (around line 21):
```ts
  const isError = detectIsError(input, toolOutput);
```

Add `is_error` to the observations INSERT:
```ts
    const res = db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, is_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, project, toolName, storedInput, storedOutput, filesTouched, isError, now],
    );
```

Leave the compression/originals logic and the `{ continue: true }` return unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hooks/post-tool-use.test.ts`
Expected: PASS — payload-flag → 1, heuristic → 1, success → 0, odd-payload never throws; and the pre-existing post-tool-use tests still pass (their benign outputs detect as `is_error=0`, which none of them assert against).

- [ ] **Step 5: Type-check + commit**

Run: `bun run typecheck`
Expected: exits 0.

```bash
git add src/hooks/post-tool-use.ts tests/hooks/post-tool-use.test.ts
git commit -m "feat: capture is_error on each observation at PostToolUse"
```

---

### Task 4: `src/distill.ts` core

**Files:**
- Create: `src/distill.ts`
- Test: `tests/distill.test.ts`

**Interfaces:**
- Consumes: `getDb` (tests); the `observations.is_error` column + `corrections` table (Task 2); `bun:sqlite` `Database` type; `node:crypto`.
- Produces:
  - `interface ObservationRow { id; tool_name; tool_input; tool_output; files_touched: string|null; is_error: number; created_at }`
  - `interface RecoveryPair { error: ObservationRow; recovery: ObservationRow }`
  - `normalizeTarget(toolName, toolInput, filesTouched): string`
  - `detectErrorRecoveryPairs(observations): RecoveryPair[]`
  - `correctionHash(text): string` — sha256 of normalized text, first 16 hex chars (project is NOT in the hash; per-project scoping comes from the table's `UNIQUE(project, content_hash)`)
  - `distillCorrections(db, sessionId, project, phrase): Promise<number>` — `phrase` is REQUIRED and injected; distill.ts never spawns `claude`.
- **Critical:** `distillCorrections` returns `0` BEFORE `phrase` is referenced when there are no pairs.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/distill.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../src/db';
import {
  normalizeTarget, detectErrorRecoveryPairs, correctionHash, distillCorrections,
  type ObservationRow, type RecoveryPair,
} from '../src/distill';

const DB = '/tmp/wayfarer-test-distill.db';
function cleanup() { for (const s of ['', '-wal', '-shm']) { try { unlinkSync(DB + s); } catch {} } }

function row(p: Partial<ObservationRow> & { tool_name: string; is_error: number; created_at: number }): ObservationRow {
  return {
    id: p.id ?? 0, tool_name: p.tool_name, tool_input: p.tool_input ?? '',
    tool_output: p.tool_output ?? '', files_touched: p.files_touched ?? null,
    is_error: p.is_error, created_at: p.created_at,
  };
}
function seedObs(db: ReturnType<typeof getDb>, sessionId: string, o: { tool_name: string; tool_input: string; is_error: number; created_at: number }): number {
  db.run('INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?,?,?)', [sessionId, '/p', o.created_at]);
  return Number(db.run(
    `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, is_error, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [sessionId, '/p', o.tool_name, o.tool_input, '', null, o.is_error, o.created_at],
  ).lastInsertRowid);
}
function seedRecoverablePair(db: ReturnType<typeof getDb>, sessionId: string, cmd: string, t: number) {
  seedObs(db, sessionId, { tool_name: 'Bash', tool_input: JSON.stringify({ command: cmd }), is_error: 1, created_at: t });
  seedObs(db, sessionId, { tool_name: 'Bash', tool_input: JSON.stringify({ command: cmd }), is_error: 0, created_at: t + 1 });
}

describe('normalizeTarget', () => {
  it('extracts the Bash command from JSON tool_input (whitespace-collapsed)', () => {
    expect(normalizeTarget('Bash', JSON.stringify({ command: 'npm   test' }), null)).toBe('npm test');
  });
  it('extracts the file_path from JSON tool_input', () => {
    expect(normalizeTarget('Edit', JSON.stringify({ file_path: '/p/src/a.ts' }), null)).toBe('/p/src/a.ts');
  });
  it('falls back to first files_touched, then raw input', () => {
    expect(normalizeTarget('Read', 'not json', 'src/a.ts,src/b.ts')).toBe('src/a.ts');
    expect(normalizeTarget('Unknown', 'plain', null)).toBe('plain');
  });
});

describe('detectErrorRecoveryPairs', () => {
  const T = (n: number) => 1000 + n;
  it('pairs an error with the EARLIEST later same-target success', () => {
    const rows: ObservationRow[] = [
      row({ id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: T(1) }),
      row({ id: 2, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 0, created_at: T(3) }),
      row({ id: 3, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 0, created_at: T(5) }),
    ];
    const pairs = detectErrorRecoveryPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].error.id).toBe(1);
    expect(pairs[0].recovery.id).toBe(2);
  });
  it('no pair when the later success is on a different target', () => {
    expect(detectErrorRecoveryPairs([
      row({ id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: T(1) }),
      row({ id: 2, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'ls' }), is_error: 0, created_at: T(3) }),
    ])).toHaveLength(0);
  });
  it('no pair when the error is never followed by a same-target success', () => {
    expect(detectErrorRecoveryPairs([
      row({ id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: T(1) }),
      row({ id: 2, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: T(3) }),
    ])).toHaveLength(0);
  });
});

describe('correctionHash', () => {
  it('collides on case/whitespace-normalized text, differs on distinct text', () => {
    expect(correctionHash('Run npm ci  first')).toBe(correctionHash('run   NPM CI first'));
    expect(correctionHash('a')).not.toBe(correctionHash('b'));
  });
});

describe('distillCorrections — no-pair guard', () => {
  beforeEach(cleanup); afterEach(cleanup);
  it('emits zero corrections AND never invokes phrase when there is no error→recovery pair', async () => {
    const db = getDb(DB);
    // an unrecovered error (no later same-target success) + an unrelated success
    seedObs(db, 's1', { tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), is_error: 1, created_at: 1000 });
    seedObs(db, 's1', { tool_name: 'Read', tool_input: JSON.stringify({ file_path: '/p/x.ts' }), is_error: 0, created_at: 1001 });
    let phraseCalls = 0;
    const spy = async (_pairs: RecoveryPair[]) => { phraseCalls++; return ['SHOULD NOT BE WRITTEN']; };
    const inserted = await distillCorrections(db, 's1', '/p', spy);
    expect(inserted).toBe(0);
    expect(phraseCalls).toBe(0); // the LLM must be unreachable on the no-pair path
    expect((db.query('SELECT COUNT(*) AS n FROM corrections').get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe('distillCorrections — insertion + dedup both directions', () => {
  beforeEach(cleanup); afterEach(cleanup);
  it('inserts a correction for a real error→recovery pair', async () => {
    const db = getDb(DB);
    seedRecoverablePair(db, 's1', 'npm test', 1000);
    expect(await distillCorrections(db, 's1', '/p', async () => ['Run npm ci before npm test.'])).toBe(1);
    expect((db.query('SELECT correction FROM corrections WHERE project = ?').get('/p') as { correction: string }).correction)
      .toBe('Run npm ci before npm test.');
    db.close();
  });
  it('dedups an identical correction and does NOT swallow a different one', async () => {
    const db = getDb(DB);
    seedRecoverablePair(db, 's1', 'npm test', 1000);
    seedRecoverablePair(db, 's2', 'npm test', 2000);
    seedRecoverablePair(db, 's3', 'npm test', 3000);
    expect(await distillCorrections(db, 's1', '/p', async () => ['Run npm ci first.'])).toBe(1);
    expect(await distillCorrections(db, 's2', '/p', async () => ['run   NPM CI first.'])).toBe(0); // normalized-identical → ignored
    expect(await distillCorrections(db, 's3', '/p', async () => ['Pin the Node version in .nvmrc.'])).toBe(1); // different → inserted
    expect((db.query('SELECT COUNT(*) AS n FROM corrections WHERE project = ?').get('/p') as { n: number }).n).toBe(2);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/distill.test.ts`
Expected: FAIL — cannot resolve `../src/distill` / exports undefined.

- [ ] **Step 3: Write the implementation**

```ts
// src/distill.ts
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

export interface ObservationRow {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  files_touched: string | null;
  is_error: number;
  created_at: number;
}

export interface RecoveryPair {
  error: ObservationRow;
  recovery: ObservationRow;
}

const BASH_TOOLS = new Set(['Bash', 'BashOutput']);

export function normalizeTarget(toolName: string, toolInput: string, filesTouched: string | null): string {
  let target = '';
  try {
    const parsed = JSON.parse(toolInput) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      if (BASH_TOOLS.has(toolName) && typeof parsed.command === 'string') target = parsed.command;
      else if (typeof parsed.file_path === 'string') target = parsed.file_path;
    }
  } catch {
    // tool_input isn't JSON — fall through to the fallbacks
  }
  if (!target && filesTouched) target = filesTouched.split(',')[0] ?? '';
  if (!target) target = toolInput;
  return target.trim().replace(/\s+/g, ' ');
}

export function detectErrorRecoveryPairs(observations: ObservationRow[]): RecoveryPair[] {
  const sorted = [...observations].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const pairs: RecoveryPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const error = sorted[i];
    if (error.is_error !== 1) continue;
    const target = normalizeTarget(error.tool_name, error.tool_input, error.files_touched);
    for (let j = i + 1; j < sorted.length; j++) {
      const recovery = sorted[j];
      if (recovery.is_error !== 0) continue;
      if (recovery.tool_name !== error.tool_name) continue;
      if (normalizeTarget(recovery.tool_name, recovery.tool_input, recovery.files_touched) !== target) continue;
      pairs.push({ error, recovery });
      break; // earliest later success
    }
  }
  return pairs;
}

export function correctionHash(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export async function distillCorrections(
  db: Database,
  sessionId: string,
  project: string,
  phrase: (pairs: RecoveryPair[]) => Promise<string[]>,
): Promise<number> {
  const observations = db.query(
    `SELECT id, tool_name, tool_input, tool_output, files_touched, is_error, created_at
     FROM observations WHERE session_id = ? ORDER BY created_at ASC`,
  ).all(sessionId) as ObservationRow[];

  const pairs = detectErrorRecoveryPairs(observations);
  if (pairs.length === 0) return 0; // no observed recovery → never call phrase, never write a fabricated fix

  const corrections = await phrase(pairs);
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  for (const raw of corrections) {
    const text = (raw ?? '').trim();
    if (!text) continue;
    const res = db.run(
      'INSERT OR IGNORE INTO corrections (project, correction, content_hash, source_session_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [project, text, correctionHash(text), sessionId, now],
    );
    if (res.changes > 0) inserted++;
  }
  return inserted;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/distill.test.ts`
Expected: PASS — including the no-pair guard (spy asserted un-called) and dedup-both-directions.

- [ ] **Step 5: Type-check + commit**

Run: `bun run typecheck`
Expected: exits 0.

```bash
git add src/distill.ts tests/distill.test.ts
git commit -m "feat: distill error→recovery pairs into deduped corrections"
```

---

<!-- Task detail appended incrementally, one task per commit. -->
