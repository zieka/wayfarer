# Compress observations at capture

**Date:** 2026-08-06
**Status:** Approved design — ready for implementation plan
**Feature:** #2 of the Wayfarer token-efficiency roadmap (stacks on feature #1, `feat/token-budgeted-injection`)

## Goal

Stop storing tool outputs (and inputs) untruncated. Compress large observation
fields at capture time with type-aware heuristics, keeping the full original in a
TTL'd side table. This shrinks the DB, de-noises the FTS index so relevance
ranking surfaces real signal, and produces the compressed form + originals store
that the reversible-retrieve feature (#3) will build on.

## Problem with current behavior

- `handlePostToolUse` (`src/hooks/post-tool-use.ts:13-34`) stores `tool_input` and
  `tool_output` **fully untruncated**. A large `Read` or a noisy `Bash`/build log
  lands whole.
- `tool_output` is only ever FTS-indexed (`observations_fts.tool_output`); it is
  never directly injected. A 100KB log of INFO lines pollutes FTS ranking so
  searches match noise instead of the error that mattered.
- The DB grows without bound.

## Decisions (locked during brainstorming)

1. **Preserve originals with a TTL.** Store the compressed field in the
   `observations` row (what gets FTS-indexed / injected / summarized) AND the full
   original in a new `observation_originals` table, pruned by age. This also seeds
   feature #3's retrieve tool.
2. **Lean compressors.** A **generic** head/tail + drop-middle compressor for
   everything over threshold, plus a **log-aware** strategy that preserves
   error/warning/traceback lines (so signal buried mid-log isn't lost). Grep /
   JSON / diff use the generic path for now.
3. **Approach A: new `src/compress.ts` module** of small, independently testable
   units + a v4 migration for the originals table; capture wires them in; TTL
   pruning runs in the detached background worker (off the hot path).
4. **Defaults:** ~2KB compression threshold (`WAYFARER_COMPRESS_THRESHOLD`);
   14-day originals TTL (`WAYFARER_ORIGINALS_TTL_DAYS`); capture never blocks —
   on compression error, hard-truncate to a cap and skip the original.

## Global constraints

- **Never block or throw in capture.** The observation INSERT must always happen
  and the hook must always return `{ continue: true }`. Compression is wrapped so
  any failure falls back to a hard-truncated value with no original saved.
- **File-path extraction runs on the ORIGINAL `tool_input`, before compression**,
  so `files_touched` is never degraded by compression.
- **No-inflate:** if compression does not shrink a field, store the original value
  and record it as not-compressed (no originals row for that field).
- Compressed fields must be bounded by `MAX_COMPRESSED_CHARS`.
- New table only (`observation_originals`, migration v4). No changes to existing
  columns. Existing FTS tables and triggers are unchanged (they index whatever the
  `observations` row now holds — the compressed text).
- Neutral naming throughout — no external project name in code, comments,
  markers, commits, branches, or PRs.

## Architecture

New module **`src/compress.ts`** — pure, testable units plus one prune helper:

- `getCompressThreshold(): number` — parse `WAYFARER_COMPRESS_THRESHOLD`; default
  `2048`; invalid/unset → default.
- `getOriginalsTtlDays(): number` — parse `WAYFARER_ORIGINALS_TTL_DAYS`; default
  `14`; invalid/unset → default.
- `pickStrategy(toolName: string, text: string): 'log' | 'generic'` — `'log'` when
  the tool is shell-like (`Bash`, `BashOutput`) OR the text shows log signals
  (`/\b(ERROR|WARN(?:ING)?|FAIL(?:ED)?|Traceback|Exception|panic)\b/` or
  stack-frame lines like `    at `); otherwise `'generic'`.
- `compressGeneric(text: string): string` — keep the first `HEAD_LINES` and last
  `TAIL_LINES` lines, replace the dropped middle with a single marker
  `… [wayfarer: dropped N lines] …`; then if still over `MAX_COMPRESSED_CHARS`,
  char-slice to fit with a `… [wayfarer: dropped N chars] …` marker. A single
  giant line with no newlines is char-sliced head+marker+tail.
- `compressLog(text: string): string` — classify lines; **keep** the first
  `CONTEXT_LINES`, the last `SUMMARY_LINES`, and every high-signal line
  (capped at `MAX_SIGNAL_LINES`), preserving original order; collapse each run of
  dropped low-signal lines into one `… [wayfarer: dropped N lines] …` marker; cap
  the result to `MAX_COMPRESSED_CHARS`. Errors located anywhere in the log survive.
- `compressField(toolName: string, text: string): { text: string; compressed: boolean }`
  — if `text.length <= getCompressThreshold()` return `{ text, compressed: false }`.
  Otherwise run the chosen strategy inside a try/catch; on success, if the result
  is not shorter than the input return `{ text, compressed: false }` (no-inflate),
  else `{ text: result, compressed: true }`; on thrown error return
  `{ text: hardTruncate(text), compressed: true }`.
- `compressForStorage(toolName, toolInput, toolOutput): { input: {text,compressed}, output: {text,compressed} }`
  — the single dispatcher the hook calls (one seam, easy to inject in tests).
- `hardTruncate(text: string): string` — internal fallback: char-slice to
  `MAX_COMPRESSED_CHARS` with a `… [wayfarer: dropped N chars] …` marker. Used by
  `compressField`'s catch and by the hook's own fallback on a compression throw.
- `pruneOriginals(db, nowSeconds: number): number` — `DELETE FROM
  observation_originals WHERE created_at < nowSeconds - ttlSeconds`; returns rows
  deleted. Wrapped by the caller so it never blocks.

Constant defaults (tunable in code): `HEAD_LINES = 40`, `TAIL_LINES = 15`,
`CONTEXT_LINES = 10`, `SUMMARY_LINES = 10`, `MAX_SIGNAL_LINES = 100`,
`MAX_COMPRESSED_CHARS = 4096`.

### DB migration (v4)

```sql
CREATE TABLE IF NOT EXISTS observation_originals (
  observation_id INTEGER PRIMARY KEY,
  tool_input_full TEXT,        -- non-null only if the input was compressed
  tool_output_full TEXT,       -- non-null only if the output was compressed
  created_at INTEGER NOT NULL,
  FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_originals_created ON observation_originals(created_at);
PRAGMA user_version = 4;
```

`ON DELETE CASCADE` means originals disappear automatically if the observation is
ever deleted. The `created_at` index makes TTL pruning a cheap range delete.

## Data flow

### Capture — `handlePostToolUse`
1. Extract file paths from the **original** `tool_input` (`extractFilePaths`) →
   `files_touched`. (Unchanged from today; must stay before compression.)
2. Compute the stored values in a try/catch so capture can never be blocked:
   `const { input, output } = compress(toolName, toolInput, toolOutput)` where
   `compress` defaults to `compressForStorage` and is injectable for tests. On any
   throw, fall back to `input = { text: hardTruncate(toolInput), compressed: false }`
   and likewise for `output` (no originals will be saved), and log to stderr.
3. **Always** INSERT the observation with `input.text` / `output.text` — this runs
   whether or not step 2 threw.
4. If `input.compressed || output.compressed`, INSERT one `observation_originals`
   row keyed by the new observation id (`lastInsertRowid`), storing
   `tool_input_full` = original input when `input.compressed` else null (same for
   output), and `created_at = now`. Because the failure fallback marks both fields
   `compressed: false`, a compression failure saves no originals.
5. Return `{ continue: true }`.

The hook signature gains an optional deps arg:
`handlePostToolUse(input, dbPath?, deps?: { compress?: typeof compressForStorage })`.

### TTL pruning — background worker
`src/summarize-worker.ts` runs detached at session end (already, when the session
has observations). After its summarization work, call
`pruneOriginals(db, nowSeconds)` inside a try/catch (non-fatal). No hot-path hook
pays for pruning.

## Error handling

- Capture: compression failure → hard-truncated store, no original, `{continue:true}`,
  never throws (covered by a dedicated test injecting a throwing compressor).
- `compressField`/`compressLog`/`compressGeneric`: internally defensive; a strategy
  throw is caught in `compressField` and degrades to `hardTruncate`.
- `pruneOriginals`: caller wraps in try/catch; a prune failure never affects the
  summary write.

## Backward compatibility

- Migration is additive (new table only); existing rows and FTS indexes are
  untouched. Observations captured before this feature simply have no originals row.
- Existing tests that insert small observations (< threshold) are unaffected —
  those fields are stored verbatim (`compressed: false`).
- FTS behavior is unchanged in shape; it now indexes compressed text, which is the
  intended de-noising.

## Testing (TDD — tests first)

`tests/compress.test.ts`:
- `getCompressThreshold` / `getOriginalsTtlDays`: default, valid override, invalid override.
- `pickStrategy`: `Bash` → `'log'`; prose containing `ERROR` → `'log'`; plain prose → `'generic'`.
- `compressGeneric`: under-threshold passthrough (via `compressField`); over-threshold keeps head+tail, inserts the dropped-lines marker, and shrinks; single no-newline giant line is handled.
- `compressLog`: an `ERROR` line in the **middle** of a long log is preserved; a contiguous traceback block is preserved; low-signal middle is dropped; result is smaller.
- `compressField`: no-inflate (returns original, `compressed:false`, when compression wouldn't shrink); threshold gate.
- `compressForStorage`: returns both fields with correct `compressed` flags.
- `pruneOriginals`: deletes rows with `created_at` older than the TTL, keeps recent rows, returns the delete count.

`tests/hooks/post-tool-use.test.ts`:
- Large `tool_output` → observations row stores a shorter compressed value AND an `observation_originals` row holds the full original output.
- Small output → stored verbatim, **no** `observation_originals` row.
- **[Constraint 1 — regression]** A compressed observation whose original `tool_input` contains a file path in the compressed-away region still records that path in `files_touched` (proves extraction ran on the original before compression).
- **[Constraint 2 — failure path]** Injecting a `compress` dep that throws still inserts the observation row and returns `{ continue: true }` without throwing.

`tests/db.test.ts`:
- v4 migration creates `observation_originals` with the FK and `idx_originals_created`; `PRAGMA user_version` is 4.

## Scope guard (explicitly deferred)

- No retrieve tool / MCP surface — that is feature #3 (this feature only stores and
  TTL-prunes originals).
- No grep/JSON/diff-specific compressors — generic path covers them for now.
- No changes to the summarizer's use of `tool_input`, and no feeding compressed
  `tool_output` into the summary prompt (possible later quality work, out of scope).
- No re-compression / backfill of pre-existing observations.

## Files touched

- **Add:** `src/compress.ts`, `tests/compress.test.ts`.
- **Modify:** `src/db.ts` (v4 migration), `src/hooks/post-tool-use.ts` (wire
  compression + originals + injectable `compress` dep), `src/summarize-worker.ts`
  (call `pruneOriginals`).
- **Update tests:** `tests/hooks/post-tool-use.test.ts`, `tests/db.test.ts`.
