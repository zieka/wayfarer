# Wayfarer

Persistent memory plugin for Claude Code. Captures observations to SQLite, injects relevant context into future sessions.

## Architecture

- Hooks are the entire runtime — no daemon, no HTTP server
- Each hook is a short-lived Bun process: read stdin JSON, write/read SQLite, output stdout JSON
- SQLite in WAL mode at `~/.wayfarer/wayfarer.db`
- FTS5 for search with recency-weighted scoring

## Build

```bash
bun install && bun run build
```

## Test

```bash
bun test
```

## File Layout

- `src/` — TypeScript source
- `plugin/` — Built plugin (installed to `~/.claude/plugins/`)
- `tests/` — Test files
