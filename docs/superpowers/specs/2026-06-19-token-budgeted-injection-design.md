# Token-budgeted, relevance-ranked context injection

**Date:** 2026-06-19
**Status:** Approved design — ready for implementation plan
**Feature:** #1 of the Wayfarer token-efficiency roadmap

## Goal

Make Wayfarer's injected context **token-budgeted** and **relevance-ranked** instead of
a fixed-row recency dump, and wire in the existing (currently unused) vector search —
without regressing hook latency. Serves the north star: a hyper-performant memory layer
that minimizes token usage.

## Problem with current behavior

- `SessionStart` calls `buildContext(project, undefined, ...)` (`src/hooks/session-start.ts:11`).
  With no query it dumps the 20 most recent `session_summaries` by recency — no relevance,
  no token ceiling.
- `vectorSearch()` (`src/context.ts:125`) requires a query and is **never called** by any hook.
  Semantic relevance is therefore impossible at `SessionStart` (the hook fires before the
  user types). A query only exists at `UserPromptSubmit`, which today only records the
  session and injects nothing (`src/hooks/user-prompt-submit.ts:30`).
- Injection size is bounded by row count (`LIMIT 20`/`LIMIT 10`), not by tokens.

## Decisions (locked during brainstorming)

1. **Both injection points.** `SessionStart` = recency primer (no query). `UserPromptSubmit`
   = relevance-ranked retrieval (query = the prompt). Both share one budget policy + formatter.
2. **FTS5-first, vectors as fallback.** FTS5 BM25 runs first (sub-ms, no model). The
   embedding model loads only when FTS5 is weak/empty. Keeps the hot path fast because every
   hook is a fresh short-lived Bun process and the fastembed model loads per-process.
3. **Token ceiling ~1200 per injection**, overridable via `WAYFARER_CONTEXT_TOKEN_BUDGET`.
   Estimation via dependency-free `chars/4`.
4. **Code structure: extract `src/retrieve.ts`** (approach B) — small, independently testable
   units; `src/context.ts` logic migrates in and `context.ts` is removed.

## Architecture

New module **`src/retrieve.ts`** owns retrieval, ranking, budget, and formatting. Two thin
entry points compose shared units:

- `primerForSession(project: string, dbPath?: string): string | null` — used by `SessionStart`.
- `relevantForPrompt(project: string, prompt: string, opts?: { dbPath?: string; embed?: (text: string) => Promise<Float32Array> }): Promise<string | null>` — used by `UserPromptSubmit`.

### Shared units (each ~15–25 lines, unit-testable)

- `estimateTokens(text: string): number` → `Math.ceil(text.length / 4)`.
- `fitToBudget<T>(items: T[], budget: number, sizeOf: (item: T) => number): T[]` — greedy fill
  in ranked order while `running + sizeOf(item) <= budget`. **At-least-one guarantee**: if the
  top item alone exceeds budget, return just that item; the entry point then truncates the
  single summary's text (`chars ≈ budget * 4`) before formatting so the block fits.

- `CANDIDATE_CAP = 30` — max rows pulled from any SQL query before budget trimming. Bounds query
  cost; the token budget does the real limiting.
- `formatSummaryContext(items, header): string` — the `**time:** summary \nFiles: …` block
  wrapped in `<wayfarer-context>` (preserves current `buildSummaryContext` format).
- `formatObservationContext(rows): string` — the `| Time | Tool | Files | Context |` table
  (preserves current fallback format).
- `toFtsQuery(prompt: string): string` — sanitize free-text into FTS5-safe tokens: extract
  word tokens (`/[A-Za-z0-9_]+/`), drop empties, OR-join, escape/wrap to avoid `MATCH`
  operator interpretation. Returns `""` when no usable tokens (caller skips FTS5).
- `getBudget(): number` — parse `WAYFARER_CONTEXT_TOKEN_BUDGET` once; fall back to `1200` on
  unset/invalid.

### Token budget

- Default `1200`, env-overridable. Each hook invocation gets its own ceiling (the two hooks
  are separate processes; "shared budget" = same policy/value, not a shared running total).
- Budget counts the formatted output: sum of per-item block size plus reserved header overhead.

## Data flow

### SessionStart → `primerForSession`
1. Query `session_summaries` for project, `ORDER BY created_at DESC LIMIT CANDIDATE_CAP`.
2. `fitToBudget` over candidates (recency order = rank order here).
3. `formatSummaryContext(items, "## Recent work in this project")`.
4. If no summaries exist, fall back to recent `observations` (budgeted, table format) —
   preserves today's behavior for fresh projects.
5. Return `null` when nothing exists → hook injects nothing.

### UserPromptSubmit → record session (existing) then `relevantForPrompt`
1. Truncate prompt to ~2000 chars (BGE max ≈ 512 tokens; bounds embed cost).
2. `toFtsQuery(prompt)`; if non-empty, FTS5 search `session_summaries_fts`, ranked by the
   existing recency-weighted formula `(rank * -1.0) * (1.0 / (1.0 + age_days))`, `LIMIT CANDIDATE_CAP`.
3. **If FTS5 results `< MIN_FTS_RESULTS` (default 3)**: load embedder (`opts.embed` or real
   `getEmbedding`), vector-search `summary_embeddings` (cosine ≥ `0.3`), merge with FTS5 hits,
   **dedup by `summary_id`**.
4. Merge ordering: FTS5 (keyword) hits first, then vector-only hits by descending similarity.
5. `fitToBudget` → `formatSummaryContext(items, "## Relevant past work")`.
6. If no summary matches at all, fall back to `observations_fts` (budgeted, table format).
7. Inject via `hookSpecificOutput` (`hookEventName: "UserPromptSubmit"`, `additionalContext`).
8. Return `null`/inject nothing on empty.

## Scoring

- **Primer:** recency (`created_at DESC`). No importance/access columns yet — deferred to the
  `learn` feature.
- **Relevant / FTS5:** reuse `(rank * -1.0) * (1.0 / (1.0 + age_days))`.
- **Vector fallback:** cosine similarity, threshold `0.3` (existing).

## Error handling — must never block a prompt

- Both hooks keep their `try/catch`; on any failure, inject nothing and return `{continue: true}`.
- Embedder load/embed failure → fall back to FTS5-only (non-fatal; matches current behavior).
- `toFtsQuery` plus a `try/catch` around `MATCH` prevent FTS5 syntax crashes on odd prompts.
- Empty results → `null` → no injection.

## Backward compatibility

- Summaries without an embedding row simply don't appear in vector results; FTS5 still covers them.
- Fresh projects with only observations (no summaries) keep working via the observation
  fallbacks in both entry points.
- No schema/migration changes.

## Testing (TDD — tests first)

- Injectable embedder (`opts.embed`) lets the vector-fallback path be tested with a fast fake —
  no ONNX load in tests.
- Unit tests:
  - `estimateTokens`.
  - `fitToBudget`: empty, all-fit, partial-fit, single-item-over-budget (at-least-one + truncation).
  - `toFtsQuery`: quotes, parens, colons, empty/whitespace, normal text.
  - `formatSummaryContext` / `formatObservationContext`.
  - `getBudget`: default, valid override, invalid override.
  - `primerForSession`: summaries present (budget-trimmed), none → observations fallback, empty → null.
  - `relevantForPrompt`: FTS5-hit path, FTS5-weak → vector fallback (fake embedder), obs fallback, empty → null.
- Update `tests/hooks/session-start.test.ts` and `tests/hooks/user-prompt-submit.test.ts`.
- Migrate/rename `tests/context.test.ts` to cover `retrieve.ts`.

## Scope guard (explicitly deferred)

- No new DB columns; no `importance`/`access_count` tracking (belongs with the `learn` feature).
- No warm-model daemon / persistent embedder (would violate the no-daemon constraint).
- No Reciprocal Rank Fusion — keyword-first merge is sufficient for the fallback case.
- No observation-level embeddings (vectors cover summaries only).

## Files touched

- **Add:** `src/retrieve.ts`, tests for it.
- **Edit:** `src/hooks/session-start.ts` (use `primerForSession`), `src/hooks/user-prompt-submit.ts`
  (add `relevantForPrompt` injection after the session-record write).
- **Remove:** `src/context.ts` (logic migrated); update importers.
- **Update:** affected tests.
