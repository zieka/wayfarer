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

<!-- Task detail appended incrementally, one task per commit. -->
