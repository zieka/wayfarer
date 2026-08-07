---
name: wayfarer-retrieve
description: "Retrieve the full original of a compressed past observation by its id. Use when a #id from wayfarer-search or injected context needs its full tool input/output."
---

# Wayfarer Retrieve

Expand a compressed past observation back to its full original tool input/output.

## When to Use

- You saw a `#<id>` in injected `<wayfarer-context>` or in `wayfarer-search` results and need the full detail behind it.
- A context row or search result is truncated (shows a `[wayfarer: dropped …]` marker) and you need what was dropped.

## How to Retrieve

Run with the observation id:

```bash
bun "$CLAUDE_PLUGIN_ROOT/scripts/retrieve.js" <observationId>
```

## Reading the Output

- `## Observation #<id> — <tool> @ <time>`, then `### Input` / `### Output` with the full original content.
- `(original expired — showing compressed form)` on a field: the original passed its retention window; only the compressed form remains.
- `no observation with id <id>`: no such observation exists.
- `error retrieving observation <id>: <message>`: retrieval failed (e.g. the database is unreadable). This is distinct from "does not exist" — the observation may well exist.
