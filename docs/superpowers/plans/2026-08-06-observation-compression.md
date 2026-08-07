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

<!-- Task detail appended incrementally, one task per commit. -->
