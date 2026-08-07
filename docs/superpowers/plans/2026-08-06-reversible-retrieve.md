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

### Task 1: Marker unification + prune-cutoff test

**Files:**
- Modify: `src/compress.ts`
- Test: `tests/compress.test.ts`

**Interfaces:**
- Consumes: existing `compress.ts` internals (`MAX_COMPRESSED_CHARS`, `HEAD_LINES`/`TAIL_LINES`, `getOriginalsTtlDays`, `pruneOriginals`) and the schema from feature #2.
- Produces:
  - `compressionMarker(detail: string): string` → exactly `… [wayfarer: ${detail}] …`
  - `COMPRESSION_MARKER_RE: RegExp` → `/\[wayfarer: [^\]]*\]/` (no `g` flag)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/compress.test.ts — merge the two new names into the existing `../src/compress` import,
// then add these describes.
import { compressionMarker, COMPRESSION_MARKER_RE } from '../src/compress';

describe('compressionMarker', () => {
  it('wraps the detail in the canonical wayfarer marker', () => {
    expect(compressionMarker('dropped 5 lines')).toBe('… [wayfarer: dropped 5 lines] …');
  });
});

describe('COMPRESSION_MARKER_RE', () => {
  it('matches each marker variant', () => {
    expect(COMPRESSION_MARKER_RE.test(compressionMarker('dropped 3 chars'))).toBe(true);
    expect(COMPRESSION_MARKER_RE.test(compressionMarker('dropped 12 lines'))).toBe(true);
    expect(COMPRESSION_MARKER_RE.test(compressionMarker('dropped middle for size'))).toBe(true);
  });
  it('does not match plain text', () => {
    expect(COMPRESSION_MARKER_RE.test('just some normal tool output')).toBe(false);
  });
  it('is stateless across repeated calls (no g flag)', () => {
    const s = compressionMarker('dropped 1 lines');
    expect(COMPRESSION_MARKER_RE.test(s)).toBe(true);
    expect(COMPRESSION_MARKER_RE.test(s)).toBe(true); // a /g regex would flip to false here
  });
});
```

```ts
// tests/compress.test.ts — add inside the existing `describe('pruneOriginals', ...)` block
// (it already defines PRUNE_DB, cleanupPrune, and imports getDb/pruneOriginals/unlinkSync).
  it('keeps a row exactly at the cutoff and deletes one just past it (strict <)', () => {
    delete process.env.WAYFARER_ORIGINALS_TTL_DAYS; // default 14 days
    const db = getDb(PRUNE_DB);
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 14 * 86400;
    db.run('INSERT INTO sessions (session_id, project, started_at) VALUES (?,?,?)', ['s1', '/p', now]);
    const mkObs = (createdAt: number) => db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['s1', '/p', 'Bash', 'in', 'out', null, createdAt],
    ).lastInsertRowid;
    const atCutoff = mkObs(cutoff);
    const pastCutoff = mkObs(cutoff - 1);
    db.run('INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at) VALUES (?,?,?,?)', [atCutoff, null, 'full-at', cutoff]);
    db.run('INSERT INTO observation_originals (observation_id, tool_input_full, tool_output_full, created_at) VALUES (?,?,?,?)', [pastCutoff, null, 'full-past', cutoff - 1]);

    const deleted = pruneOriginals(db, now);
    expect(deleted).toBe(1); // only the past-cutoff row
    const rows = db.query('SELECT observation_id FROM observation_originals').all() as Array<{ observation_id: number }>;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].observation_id)).toBe(Number(atCutoff)); // exactly-at-cutoff survives
    db.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/compress.test.ts`
Expected: FAIL — `compressionMarker` / `COMPRESSION_MARKER_RE` not exported; the cutoff-boundary test is new.

- [ ] **Step 3: Refactor `compress.ts` (behavior-preserving)**

Add, right after the `MAX_COMPRESSED_CHARS` constant block:

```ts
export function compressionMarker(detail: string): string {
  return `… [wayfarer: ${detail}] …`;
}

// No `g` flag — `.test()` must be stateless. Distinguishes a compressed-but-pruned
// field (marker present, original gone) from a never-compressed field.
export const COMPRESSION_MARKER_RE = /\[wayfarer: [^\]]*\]/;
```

Then replace the marker string literals in the three functions with `compressionMarker(...)`, keeping output byte-identical:

```ts
export function hardTruncate(text: string): string {
  if (text.length <= MAX_COMPRESSED_CHARS) return text;
  const dropped = text.length - MAX_COMPRESSED_CHARS;
  return text.slice(0, MAX_COMPRESSED_CHARS) + '\n' + compressionMarker(`dropped ${dropped} chars`);
}
```

```ts
export function compressGeneric(text: string): string {
  const lines = text.split('\n');
  if (lines.length > HEAD_LINES + TAIL_LINES + 1) {
    const head = lines.slice(0, HEAD_LINES).join('\n');
    const tail = lines.slice(lines.length - TAIL_LINES).join('\n');
    const droppedLines = lines.length - HEAD_LINES - TAIL_LINES;
    const marker = compressionMarker(`dropped ${droppedLines} lines`);
    const full = `${head}\n${marker}\n${tail}`;
    if (full.length <= MAX_COMPRESSED_CHARS) return full;
    const budget = Math.max(0, MAX_COMPRESSED_CHARS - marker.length - 2);
    const half = Math.floor(budget / 2);
    const headPart = head.length > half ? head.slice(0, half) : head;
    const tailPart = tail.length > half ? tail.slice(tail.length - half) : tail;
    return `${headPart}\n${marker}\n${tailPart}`;
  }
  return hardTruncate(text);
}
```

```ts
export function compressLog(text: string): string {
  const lines = text.split('\n');
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < Math.min(CONTEXT_LINES, lines.length); i++) keep[i] = true;
  for (let i = Math.max(0, lines.length - SUMMARY_LINES); i < lines.length; i++) keep[i] = true;
  let signalCount = 0;
  for (let i = 0; i < lines.length && signalCount < MAX_SIGNAL_LINES; i++) {
    if (!keep[i] && isSignal(lines[i])) { keep[i] = true; signalCount++; }
  }
  const out: string[] = [];
  let droppedRun = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (droppedRun > 0) { out.push(compressionMarker(`dropped ${droppedRun} lines`)); droppedRun = 0; }
      out.push(lines[i]);
    } else {
      droppedRun++;
    }
  }
  if (droppedRun > 0) out.push(compressionMarker(`dropped ${droppedRun} lines`));
  const result = out.join('\n');
  if (result.length <= MAX_COMPRESSED_CHARS) return result;
  const sizeMarker = compressionMarker('dropped middle for size');
  const budget = Math.max(0, MAX_COMPRESSED_CHARS - sizeMarker.length - 2);
  const half = Math.floor(budget / 2);
  return `${result.slice(0, half)}\n${sizeMarker}\n${result.slice(result.length - half)}`;
}
```

Leave `getCompressThreshold`, `getOriginalsTtlDays`, `pickStrategy`, `isSignal`, `compressField`, `compressForStorage`, and `pruneOriginals` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/compress.test.ts`
Expected: PASS — new marker/detector/cutoff tests plus all pre-existing compression tests (byte-identical marker output means none of them change).

- [ ] **Step 5: Commit**

```bash
git add src/compress.ts tests/compress.test.ts
git commit -m "feat: unify compression markers with a detector; prune-cutoff boundary test"
```

---

<!-- Task detail appended incrementally, one task per commit. -->
