# Reversible retrieve path (observation-level)

**Date:** 2026-08-06
**Status:** Approved design — ready for implementation plan
**Feature:** #3 of the Wayfarer token-efficiency roadmap (stacks on features #1 and #2, off `origin/main` = `c9fe3b4`)

## Goal

Let the model expand a compressed observation back to its full original **on demand**, so injected/searched context stays tiny but nothing is permanently lost while the original survives its TTL. Feature #2 already stores originals in `observation_originals`; this feature adds the retrieval path, surfaces the references the model needs, and folds in two directly-related deferred minors.

## Decisions (locked during brainstorming)

1. **Observation-level retrieval.** Given an observation id, return its full original `tool_input`/`tool_output`.
2. **Tested src fn + built script + skill.** Logic lives in a unit-tested `retrieveOriginal(db, id)`; a thin CLI entry is built to `plugin/scripts/retrieve.js`; a new `wayfarer-retrieve` skill invokes it via `$CLAUDE_PLUGIN_ROOT`.
3. **Reference surfacing:** the `wayfarer-search` skill shows observation `id` + an expandable indicator; the auto-injection **observation-table fallback** gains a compact `#id` column. Summaries and the summary injection path are unchanged (zero added tokens there).
4. **Folded minors:** unify the compression markers behind one builder + a detector regex (load-bearing here — see three-state resolution), and add the `created_at === cutoff` boundary test for `pruneOriginals`.

## The three-state resolution (subtle core of this feature)

After TTL pruning, an observation row is **indistinguishable by shape** from a never-compressed one: the compressed value sits in `observations`, and there is no `observation_originals` row in either case. The only signal that a field *was* compressed is the marker embedded in its stored text. So `retrieveOriginal` resolves each field (`input`, `output`) as:

1. `observation_originals.<field>_full` is non-null → return it, `expired: false` (true original preserved).
2. else the stored `observations.<field>` **matches `COMPRESSION_MARKER_RE`** → return the stored (compressed) value, `expired: true` (it was compressed; the original has been pruned).
3. else → return the stored value, `expired: false` (never compressed — the stored value **is** the full original).

The **expired (2) vs never-compressed (3)** pair is the one that will silently regress; both directions must be asserted.

## Global constraints

- `retrieveOriginal` is **strictly read-only** — no writes, no pruning, no side effects. There is no cleanup/side-effect to order relative to failure paths.
- **CLI never crashes the model's tool call:** the CLI always exits 0. But its output text must **distinguish** two outcomes:
  - **not found** (no observation row for that id) → wording like `no observation with id <N>`.
  - **real failure** (DB unreadable, corrupt row, any thrown error) → wording like `error retrieving observation <N>: <message>`.
  Conflating them is a silent failure (a broken DB would read as "does not exist").
- **Marker unification is behavior-preserving:** `compressionMarker(detail)` emits exactly `… [wayfarer: ${detail}] …`; `hardTruncate` keeps its leading `\n`. Every existing compression test must still pass unchanged — the refactor only centralizes construction and adds the detector.
- `COMPRESSION_MARKER_RE` has **no `g` flag** (stateless `.test()`), so repeated calls are stable.
- The `#id` column in the fallback table is compact; the summary injection path adds **zero** tokens.
- New skill + built script only; no MCP server / daemon (retrieval is a short-lived Bun process, consistent with the hooks-only architecture).
- Neutral naming throughout — markers keep the `wayfarer:` prefix; the skill is `wayfarer-retrieve`; no external project name anywhere.

## Architecture

### New: `src/retrieve-original.ts`
```ts
import type { Database } from 'bun:sqlite';
import { COMPRESSION_MARKER_RE } from './compress';
import { getDb } from './db';

export interface RetrievedField { text: string; expired: boolean }
export interface RetrieveResult {
  found: boolean;
  observationId: number;
  toolName?: string;
  createdAt?: number;
  input?: RetrievedField;
  output?: RetrievedField;
}

export function retrieveOriginal(db: Database, observationId: number): RetrieveResult { /* three-state resolution */ }
export function formatRetrieveResult(r: RetrieveResult): string { /* not-found vs full/expired blocks */ }
export function runRetrieve(
  args: string[],
  deps?: { openDb?: (dbPath?: string) => Database; retrieve?: typeof retrieveOriginal },
): string { /* parse id; open db; try/catch → error wording; finally db.close(); returns text */ }

if (import.meta.main) { process.stdout.write(runRetrieve(process.argv.slice(2))); process.exit(0); }
```
- `retrieveOriginal`: pure over an injected `db`; implements the three-state resolution above.
- `runRetrieve`: the testable CLI core. Injectable `openDb`/`retrieve` deps so a thrown DB error is exercisable. Validates the id (positive integer) → usage message; opens db (default `getDb`); `try { format(retrieve(db,id)) } catch (e) { error wording } finally { db.close() }`. Returns a string; the `import.meta.main` shim writes it and exits 0.

### Changed: `src/compress.ts`
- Add `export function compressionMarker(detail: string): string` and `export const COMPRESSION_MARKER_RE = /\[wayfarer: [^\]]*\]/;` (no `g`).
- Refactor the four marker sites (`hardTruncate`, `compressGeneric`, the two in `compressLog`) to call `compressionMarker(...)`, preserving exact output.

### Changed: `src/retrieve.ts` (feature #1 injection)
- `ObsRow` gains `id: number`; the two observation-fallback queries (`primerForSession`, `relevantForPrompt`) select `id`/`o.id`; `formatObservationContext` prepends an `Id` column rendering `#<id>`.

### Changed: `scripts/build.ts`
- Build `src/retrieve-original.ts` → `plugin/scripts/retrieve.js` (external `['bun:sqlite']`, esm, shebang banner), like the summarize-worker entry; update the summary log line.

### New: `plugin/skills/retrieve/SKILL.md` (`wayfarer-retrieve`)
- When-to-use: the user (or the model) wants the full original of a compressed observation seen via `wayfarer-search` or a `#id` in injected context.
- Invocation: `bun "$CLAUDE_PLUGIN_ROOT/scripts/retrieve.js" <observationId>`.
- Explains the output: full input/output; an "original expired" note; or a distinct error line if retrieval failed.
- **Discovery:** the plan must confirm the new skill is discovered the same way `plugin/skills/search/SKILL.md` is (auto-discovered from `plugin/skills/`). If `scripts/dev-install.ts` or the marketplace manifest enumerates skills explicitly, register `wayfarer-retrieve` there too and verify it loads.

### Changed: `plugin/skills/search/SKILL.md`
- Observations query `LEFT JOIN observation_originals` and selects `o.id`; output shows `#<id>` and an expandable indicator (`⤢`) when an originals row exists. (Skill markdown — not unit-tested.)

## Data flow

- **Discovery:** `wayfarer-search` (deliberate) shows `#id` + `⤢`; the auto-injection fallback table shows `#id`. Summaries carry no per-observation id.
- **Retrieve:** model runs `wayfarer-retrieve <id>` → `runRetrieve` → `retrieveOriginal` → formatted full original (or expired/ not-found/ error text).
- **Lifecycle:** unchanged from feature #2 — originals written at capture when compressed, TTL-pruned in the worker. Retrieve only reads.

## Testing (TDD — tests first)

`tests/retrieve-original.test.ts` (real SQLite; seed session → observation → optional originals row):
- **[three-state #1] original present → true original.** Compressed field with a matching `observation_originals.*_full` → `expired:false` and text equals the full original (≠ the stored compressed value).
- **[three-state #2] marker present, no originals row → `expired:true`.** Stored field contains a compression marker, no originals row → returns stored value with `expired:true`.
- **[three-state #3] no marker, no originals row → never-compressed, `expired:false`.** Stored field has no marker, no originals row → returns stored value with `expired:false`.
- The #2/#3 pair asserts **both directions** explicitly (same test file, adjacent) so a regression that collapses them fails.
- `found:false` for an unknown id.
- Both fields resolved independently (e.g. input compressed+preserved, output never-compressed) in one observation.
- `formatRetrieveResult`: not-found wording vs full vs `(original expired …)` note.
- `runRetrieve`: valid id happy path; invalid/missing id → usage message; **injected `openDb` that throws → output contains the error wording (`error retrieving observation <N>`) and NOT the not-found wording** (real-failure vs not-found distinction); injected `retrieve` that throws (corrupt row) → error wording.

`tests/compress.test.ts` (additions):
- `compressionMarker(detail)` returns exactly `… [wayfarer: ${detail}] …`.
- `COMPRESSION_MARKER_RE` matches each of the three marker variants and does not match plain text; `.test()` called twice on the same string returns the same result (no `g`-flag statefulness).
- All pre-existing compression tests remain green (behavior-preserving refactor).
- **`pruneOriginals` boundary:** a row at `created_at === cutoff` is **kept** (strict `<`), while `created_at === cutoff - 1` is deleted.

`tests/retrieve.test.ts` (feature #1, additions):
- The observation-fallback table includes the `#<id>` column for both `primerForSession` (obs fallback) and `relevantForPrompt` (obs fallback).

## Scope guard (explicitly deferred)

- No session-level retrieval (expand a summary → its observations); observation-level only.
- No changes to what gets compressed or to the summary injection path.
- No `compressed` boolean column on `observations` (the marker detector distinguishes the states — no schema change needed for retrieval; no new migration in this feature).
- Other feature-#2 deferred minors (`parseInt` leniency, UTF-16 boundary slicing, the unreachable `compressField` catch, the shared DB-block `catch`) remain deferred.

## Files touched

- **Add:** `src/retrieve-original.ts`, `tests/retrieve-original.test.ts`, `plugin/skills/retrieve/SKILL.md`.
- **Edit:** `src/compress.ts` (marker builder + detector), `src/retrieve.ts` (`#id` column), `scripts/build.ts` (build retrieve.js), `plugin/skills/search/SKILL.md` (id + expandable).
- **Update tests:** `tests/compress.test.ts` (marker + cutoff boundary), `tests/retrieve.test.ts` (fallback `#id`).
