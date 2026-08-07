# Reversible Retrieve Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model expand a compressed observation back to its full original on demand, via a tested `retrieveOriginal` + a built `plugin/scripts/retrieve.js` invoked by a `wayfarer-retrieve` skill — surfacing observation ids so it knows what to expand, and folding in two directly-related deferred minors (marker unification, prune-cutoff boundary test).

**Architecture:** New `src/retrieve-original.ts` holds the read-only retrieval logic (`retrieveOriginal`), formatting (`formatRetrieveResult`), and a testable CLI core (`runRetrieve`) with a thin `import.meta.main` entry built to `plugin/scripts/retrieve.js`. `src/compress.ts` centralizes markers behind `compressionMarker` + a no-`g` `COMPRESSION_MARKER_RE` (load-bearing: it distinguishes an expired-original from a never-compressed field). `src/retrieve.ts` and the search skill surface observation ids.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (WAL + FTS5), `bun:test`, esbuild (plugin build), Claude Code plugin skills.

## Global Constraints

- **`retrieveOriginal` is strictly read-only** — no writes, no prune, no side effects; there is no cleanup to order against a failure path.
- **Three-state resolution (per field, `input`/`output`):** (1) `observation_originals.<field>_full` non-null → return it, `expired:false`; (2) else stored `observations.<field>` matches `COMPRESSION_MARKER_RE` → return stored, `expired:true` (compressed, original pruned); (3) else → return stored, `expired:false` (never compressed; stored IS the full value). The **expired (2) vs never-compressed (3)** pair must be asserted in BOTH directions.
- **CLI always exits 0**, but its output text must distinguish: **not found** → `no observation with id <N>`; **real failure** (DB unreadable / corrupt row / any thrown error) → `error retrieving observation <N>: <message>`. Conflating them is a silent failure.
- **Marker unification is behavior-preserving:** `compressionMarker(detail)` returns exactly `… [wayfarer: ${detail}] …`; `hardTruncate` keeps its leading `\n`; the head/tail budget outputs of `compressGeneric`/`compressLog` stay byte-identical. All pre-existing compression tests must pass unchanged.
- `COMPRESSION_MARKER_RE` has **no `g` flag** — `.test()` is stateless and stable across repeated calls.
- **`pruneOriginals` uses strict `<`:** a row at `created_at === cutoff` is KEPT; `created_at === cutoff - 1` is deleted (`cutoff = now - getOriginalsTtlDays()*86400`).
- The `#id` column in the observation-fallback table is compact; the summary injection path adds ZERO tokens.
- Skill invocation: `bun "$CLAUDE_PLUGIN_ROOT/scripts/retrieve.js" <observationId>`. Confirm the skill is discovered like `plugin/skills/search/SKILL.md`; register in `scripts/dev-install.ts`/marketplace only if skills are enumerated explicitly.
- No new DB migration; no `compressed` column (the marker detector does the disambiguation).
- Neutral naming throughout — markers keep the `wayfarer:` prefix; the skill is `wayfarer-retrieve`; no external project name anywhere.
- Test DB convention: `/tmp/wayfarer-test-*.db`; `afterEach` unlinks `.db`, `-wal`, `-shm`.
- `bun test` prints a Bun C++ panic AFTER the `N pass, 0 fail` summary (nonzero exit) — known upstream shutdown bug; judge success by the pass/fail line, not the exit code.

## Tasks

1. **Marker unification + prune-cutoff test** — `compressionMarker` + `COMPRESSION_MARKER_RE` in `compress.ts` (refactor 4 sites, behavior-preserving); tests for marker format, detector (matches 3 variants, not plain text, no-`g` statelessness), and the `created_at === cutoff` boundary for `pruneOriginals`.
2. **`retrieveOriginal` + `formatRetrieveResult`** — new `src/retrieve-original.ts` with the three-state resolution and formatting; the three named three-state tests (expired-vs-never-compressed both directions), `found:false`, independent per-field resolution, and format wording.
3. **`runRetrieve` CLI core + entry** — testable CLI seam (injectable `openDb`/`retrieve`) + `import.meta.main`; tests for valid id, invalid/missing id, thrown-DB-error → error wording (NOT not-found), corrupt-row via injected throw.
4. **Build wiring + `wayfarer-retrieve` skill** — `scripts/build.ts` builds `plugin/scripts/retrieve.js`; new `plugin/skills/retrieve/SKILL.md`; confirm skill discovery; smoke-run the built script.
5. **Surface `#id` (fallback table + search skill) + gate** — `src/retrieve.ts` `ObsRow.id` + `#id` column; update `tests/retrieve.test.ts`; `plugin/skills/search/SKILL.md` id + expandable; full-suite + `bun run build` gate.

---

<!-- Task detail appended incrementally, one task per commit. -->
