# Failure distillation (+ a type-check build gate)

**Date:** 2026-08-06
**Status:** Approved design — ready for implementation plan
**Feature:** #4 (final roadmap item), off `origin/main` = `a4d2d68` (features #1–#3 merged)

## Goal

Turn repeated mistakes into durable guidance: when a tool call fails and a later
call on the same target succeeds, distill that "error → recovery" into a terse
**correction** and inject it proactively into future sessions so the model avoids
the mistake. Also add the repo's first automated gate: a hard-failing
`tsc --noEmit` type check wired into the build.

## Decisions (locked during brainstorming)

1. **Detect** failures by capturing an `is_error` flag at PostToolUse into a new
   `observations.is_error` column (schema v5), from the hook payload's error
   signal if present, else a conservative output-text heuristic.
2. **Distill** with hand-coded pairing gating an LLM phrasing step:
   `detectErrorRecoveryPairs` (pure, tested) pairs an error observation with the
   earliest later success on the same tool+target in the same session; only
   confirmed pairs are phrased by `claude -p`. Runs as a **guarded, decoupled**
   step in the summarize-worker, gated so a session with no pairs never reaches
   the LLM.
3. **Surface** corrections in a tight-capped "Known pitfalls in this project"
   section at the top of the SessionStart primer (~400-token sub-budget, ~5 items),
   deduped.
4. **Type-check gate:** `bun run build` runs `tsc --noEmit` first and **hard-fails**
   on any type error (with no CI, the build is the only enforcement point).

## Global constraints

- **The no-pair path is the most important behavior in this feature.** A fabricated
  correction is injected into future sessions as durable guidance — a wrong one
  **poisons memory persistently** rather than failing once. Therefore: if a session
  has errors but no error→recovery pair, emit **zero** corrections AND the LLM
  `phrase` function must **not be invoked at all** on that path.
- **Distillation is decoupled from summarization and pruning.** It runs in its own
  `try/catch` and must complete regardless of whether the summary `claude -p` call
  succeeds or fails (and vice-versa) — the feature-#2 prune-coupling lesson. Place
  it before the summary generation so a summary failure can't skip it.
- **Corrections outlive sessions.** `source_session_id` is stored for provenance
  with NO cascading FK — deleting/pruning a session must not delete its corrections.
- **Never block or throw** in capture or injection. `is_error` capture failure →
  default `0`, capture proceeds. Pitfalls query failure → omit the section, primer
  still returns summaries. Distillation failure → no corrections, summary/prune
  unaffected, worker exits 0.
- **Dedup by `content_hash`** = `sha256(normalize(text))[:16]`, `normalize` =
  trim + lowercase + collapse-whitespace; `UNIQUE(project, content_hash)` +
  `INSERT OR IGNORE`. Dedup must not swallow a genuinely different correction.
- Pitfalls: `PITFALLS_BUDGET = 400` tokens, `PITFALLS_CAP = 5` items; `chars/4`
  estimation (reuse `estimateTokens`). Summary injection path otherwise unchanged.
- Additive migration only (v5): a new column + a new table. Existing FTS
  tables/triggers untouched (they reference named columns, not `is_error`).
- Neutral naming throughout (`wayfarer:` markers, `Known pitfalls…` heading); no
  external project name anywhere.
- Test DB convention `/tmp/wayfarer-test-*.db`; `afterEach` unlinks `.db`/`-wal`/`-shm`.
- `bun test` prints a Bun C++ panic AFTER the `N pass, 0 fail` summary (nonzero
  exit) — known upstream bug; judge tests by the pass/fail line.

## Failure-path table (every path degrades to a safe, non-misleading state)

| Path | Behavior |
|---|---|
| Session has errors but **no** error→recovery pair | emit nothing; **`phrase` is never called** (asserted via a spy) |
| `phrase` / distillation `claude -p` fails or times out | no corrections written; summary + prune unaffected; worker exits 0 |
| Summary `claude -p` fails | distillation already ran (it precedes summary generation); unaffected |
| `is_error` signal absent in payload | conservative output-text heuristic; on any capture error → `0`, capture proceeds |
| Pitfalls query fails at injection | omit the pitfalls section; primer still returns summaries |
| Duplicate correction | `INSERT OR IGNORE` on `(project, content_hash)`; a genuinely different correction still inserts |

## Architecture

### Schema v5 (`src/db.ts`)
```sql
ALTER TABLE observations ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  correction TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_session_id TEXT,           -- provenance only; NO cascading FK
  created_at INTEGER NOT NULL,
  UNIQUE(project, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_corrections_project ON corrections(project, created_at DESC);
PRAGMA user_version = 5;
```

### Capture (`src/hooks/post-tool-use.ts`)
Compute `is_error` before the INSERT and store it (new column): use
`input.tool_response.is_error` when `tool_response` is an object exposing it, else
a conservative heuristic over the raw `tool_output` text; on any error default `0`.
Wrapped by the existing capture flow — must never block.

### `src/distill.ts` (new; pure logic + orchestration, no `claude` spawn)
```ts
import type { Database } from 'bun:sqlite';

export interface ObservationRow {
  id: number; tool_name: string; tool_input: string; tool_output: string;
  files_touched: string | null; is_error: number; created_at: number;
}
export interface RecoveryPair { error: ObservationRow; recovery: ObservationRow; }

export function normalizeTarget(toolName: string, toolInput: string, filesTouched: string | null): string;
export function detectErrorRecoveryPairs(observations: ObservationRow[]): RecoveryPair[];
export function correctionHash(project: string, text: string): string;

// phrase is REQUIRED and injected (the worker passes a claude -p impl; tests pass a fake/spy).
// distill.ts never spawns claude — it stays fully unit-testable.
export async function distillCorrections(
  db: Database,
  sessionId: string,
  project: string,
  phrase: (pairs: RecoveryPair[]) => Promise<string[]>,
): Promise<number>;
```
- `normalizeTarget`: `tool_input` is stored as a string that is often JSON (e.g. Bash stores `{"command":"…"}`, file tools store `{"file_path":"…"}`). Resolve the target by: try `JSON.parse(tool_input)`; if it has `.command` → use that (Bash); if it has `.file_path` → use that (file tools); else if `files_touched` is non-empty → use its first path; else fall back to the raw `tool_input`. Then normalize (trim + collapse internal whitespace). Pairing also requires `tool_name` equality, so Bash and Read never cross-match.
- `detectErrorRecoveryPairs`: observations ascending by `created_at`; for each `is_error=1` obs `E`, pair it with the earliest later `is_error=0` obs `S` where `S.tool_name === E.tool_name` and `normalizeTarget(S) === normalizeTarget(E)`. No match → no pair.
- `distillCorrections`: load the session's observations; `pairs = detectErrorRecoveryPairs(obs)`; **if `pairs.length === 0` return `0` immediately — before `phrase` is referenced/called**; else `phrase(pairs)` → for each non-empty correction, `INSERT OR IGNORE` with `correctionHash(project, text)`; return the number actually inserted.

### Worker (`src/summarize-worker.ts`)
Add a guarded distillation step that runs **before** summary generation, in its own
`try/catch`, using a locally-defined `claude -p` phrase function (spawns `claude`,
parses a JSON array of correction strings, returns `[]` on parse/`spawn` failure).
Independent of the summary write and the prune.

### Injection (`src/retrieve.ts`)
```ts
export interface Correction { correction: string; created_at: number; }
export function pitfallsForProject(db, project): Correction[]; // ORDER BY created_at DESC LIMIT PITFALLS_CAP
```
`primerForSession` computes a pitfalls section (own `try/catch` → `[]` on error),
budgets it to `PITFALLS_BUDGET`/`PITFALLS_CAP`, formats a `## Known pitfalls in this
project` list wrapped in its own `<wayfarer-context>` block, and returns it joined
above the existing summary/observation block. If pitfalls exist but there are no
summaries/observations, return just the pitfalls block; if nothing exists, `null`.
The summary path itself is unchanged.

### Type-check gate (`package.json`, `tsconfig.json`, `scripts/build.ts`)
- Add devDeps `typescript` and `bun-types`; add script `"typecheck": "tsc --noEmit"`.
- Ensure `tsconfig.json` resolves Bun globals (`bun-types`) and includes `src`/`tests`
  so `tsc --noEmit` runs clean; fix whatever real type errors it surfaces.
- `scripts/build.ts` runs `tsc --noEmit` first (via `Bun.spawnSync`) and **exits
  non-zero without building** if it fails — `bun run build` hard-fails on type errors.

## Testing (TDD — tests first)

`tests/distill.test.ts` (real SQLite; seed session + observations with `is_error`):
- `normalizeTarget`: Bash command normalization; file-tool path; fallback to tool name.
- `detectErrorRecoveryPairs`: an error followed by a later same-target success → one pair; an error with no later same-target success → no pair; a success on a *different* target → no pair; ordering respected (earliest later success).
- **[NAMED — no-pair guard]** `distillCorrections` on a session with errors but NO error→recovery pair returns `0`, inserts nothing, **and never calls `phrase`** — inject a `phrase` **spy** and assert it was not invoked (the LLM is unreachable on this path).
- Happy path: a real pair → `phrase` (fake) returns a correction → one row inserted.
- **[NAMED — dedup both directions]** inserting the SAME correction twice yields one row (second `INSERT OR IGNORE` is a no-op); a genuinely DIFFERENT correction is NOT swallowed (distinct `content_hash` → second row inserted).
- `correctionHash`: whitespace/case-insensitive normalization collides; substantively different text does not.

`tests/db.test.ts`: v5 migration — `observations.is_error` column exists (default 0); `corrections` table + `UNIQUE(project, content_hash)` + index exist; `user_version === 5`.

`tests/hooks/post-tool-use.test.ts`: an errored `tool_response` → row stored with `is_error = 1`; a normal one → `is_error = 0`; capture still never throws.

`tests/retrieve.test.ts`: `primerForSession` prepends the `## Known pitfalls in this project` section when corrections exist (capped/budgeted), above summaries; no corrections → no pitfalls section (summary path unchanged); a pitfalls query error degrades to no section (never throws).

Type-check: `bun run typecheck` passes on the whole tree; `bun run build` fails (non-zero) when a deliberate type error is introduced (verified once during implementation, then reverted).

## Scope guard (explicitly deferred)

- **Follow-up (NOT in this feature):** add a `compressed` boolean column to
  `observations` to make feature #3's "original expired" flag exact rather than a
  marker heuristic. Considered here since v5 is open, but `ALTER TABLE ADD COLUMN`
  is equally cheap in a later migration, so there is no while-we're-here saving and
  it would expand scope onto unrelated work. Recorded as a follow-up.
- No relevance-ranked correction injection at UserPromptSubmit (SessionStart only).
- No TTL/expiry for corrections (dedup bounds growth); revisit if the table grows.
- No cross-session pairing (recovery must be in the same session as the error).
- Prior deferred minors from #2/#3 remain deferred.

## Files touched

- **Add:** `src/distill.ts`, `tests/distill.test.ts`.
- **Edit:** `src/db.ts` (v5), `src/hooks/post-tool-use.ts` (`is_error` capture),
  `src/summarize-worker.ts` (guarded distillation step), `src/retrieve.ts`
  (pitfalls injection), `scripts/build.ts` (typecheck gate), `package.json`
  (devDeps + `typecheck` script), `tsconfig.json` (Bun types / includes as needed).
- **Update tests:** `tests/db.test.ts`, `tests/hooks/post-tool-use.test.ts`,
  `tests/retrieve.test.ts`.
