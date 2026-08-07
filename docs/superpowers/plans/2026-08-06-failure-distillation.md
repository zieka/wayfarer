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

<!-- Task detail appended incrementally, one task per commit. -->
