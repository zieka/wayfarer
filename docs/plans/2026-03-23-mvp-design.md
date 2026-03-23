# Wayfarer MVP Design

## Overview

Wayfarer is a Claude Code plugin that gives Claude persistent memory across sessions. It captures tool usage and user prompts directly to SQLite from hook scripts — no daemon, no HTTP, no background processes.

**Core principle:** Hooks are the entire runtime. Each hook script is a short-lived Bun process that reads JSON from stdin, writes to SQLite, and exits. Context injection reads from the same database and writes JSON to stdout.

## Architecture

**Data directory:** `~/.wayfarer/` contains `wayfarer.db` and logs.

**Three hooks:**

| Hook | Event | Direction |
|------|-------|-----------|
| SessionStart | `SessionStart` | Reads DB, injects context via stdout |
| UserPromptSubmit | `UserPromptSubmit` | Writes session + prompt to DB |
| PostToolUse | `PostToolUse` | Writes observation to DB |

No worker service. Every hook opens `bun:sqlite`, does its work, closes. SQLite in WAL mode handles concurrent access from multiple hook invocations. Total per-hook overhead: open file, run query, close file — single-digit milliseconds.

No AI processing in MVP. Raw observations are stored as-is. File paths are extracted via regex at write time (zero tokens). Search is FTS5 with recency weighting. AI summarization comes later as a layer on top.

## Database Schema

Single file: `~/.wayfarer/wayfarer.db`, WAL mode, foreign keys enabled.

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  prompt TEXT,
  started_at INTEGER NOT NULL,
  status TEXT CHECK(status IN ('active','completed')) NOT NULL DEFAULT 'active'
);

CREATE INDEX idx_sessions_project ON sessions(project, started_at DESC);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL,
  tool_output TEXT NOT NULL,
  files_touched TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX idx_observations_session ON observations(session_id);
CREATE INDEX idx_observations_created ON observations(created_at DESC);
CREATE INDEX idx_observations_project ON observations(project, created_at DESC);

CREATE VIRTUAL TABLE observations_fts USING fts5(
  tool_name, tool_input, tool_output, files_touched,
  content='observations', content_rowid='id'
);
```

`project` is denormalized onto `observations` to avoid joins in search queries.

Timestamps are epoch seconds (integers) for fast comparisons and compact storage.

FTS5 index is kept in sync via INSERT/UPDATE/DELETE triggers.

## Hook Implementations

### Shared database helper (`src/db.ts`)

- Opens `~/.wayfarer/wayfarer.db` with `bun:sqlite`
- Enables WAL mode and foreign keys on every connection
- Runs migrations if needed (version tracked via `PRAGMA user_version`)
- Exports prepared statement helpers for each operation
- Every hook calls `getDb()`, does its work, connection closes when process exits

### Hook 1 — UserPromptSubmit (`src/hooks/user-prompt-submit.ts`)

- Reads stdin JSON, extracts `session_id`, `project`, `prompt`
- `INSERT OR IGNORE INTO sessions` (idempotent — same session_id won't duplicate)
- Stdout: `{ "continue": true }` (no blocking, no output to user)

### Hook 2 — PostToolUse (`src/hooks/post-tool-use.ts`)

- Reads stdin JSON, extracts `session_id`, `tool_name`, `tool_input`, `tool_response`
- Extracts `files_touched` from tool_input via regex (looks for file paths)
- Extracts `project` from the event data
- `INSERT INTO observations` + updates FTS5 index via trigger
- Stdout: `{ "continue": true }`

### Hook 3 — SessionStart (`src/hooks/session-start.ts`)

- Reads stdin JSON, extracts `session_id`, `project`
- Runs recency-weighted FTS5 query
- Formats top results as markdown
- Stdout: `{ "continue": true, "systemMessage": "..." }` to inject context

All hooks exit 0 on success, exit 0 on error (fail open — never block the user's session).

## Context Injection & Search

### Recency-weighted FTS5 query

```sql
SELECT o.id, o.tool_name, o.files_touched, o.created_at,
       snippet(observations_fts, 1, '', '', '...', 32) as context
FROM observations_fts
JOIN observations o ON o.id = observations_fts.rowid
WHERE observations_fts MATCH ?
  AND o.project = ?
ORDER BY (rank * -1.0) * (1.0 / (1.0 + (? - o.created_at) / 86400.0))
DESC LIMIT 20
```

Scoring multiplies FTS5 relevance by a time decay factor. An exact match from yesterday scores higher than a partial match from today. The `86400.0` divisor converts seconds to days.

### Injected format

Top results formatted as a markdown table inside a custom tag:

```
<wayfarer-context>
## Recent relevant work in this project

| Time | Tool | Files | Context |
|------|------|-------|---------|
| 2h ago | Edit | src/auth.ts | ...modified validateToken to check expiry... |
| 1d ago | Bash | tests/auth.test.ts | ...added integration test for token refresh... |
</wayfarer-context>
```

### Fallback behavior

When there's no query (first prompt hasn't arrived yet at SessionStart): fall back to the 10 most recent observations for the project, no FTS5 involved. Recency alone is the signal.

### Token budget

Cap injected context at ~2000 tokens. Truncate `tool_input` and `tool_output` snippets aggressively — the goal is to jog Claude's memory, not replay the full conversation.

## File Structure

```
wayfarer/
├── src/
│   ├── db.ts
│   ├── files.ts
│   ├── context.ts
│   └── hooks/
│       ├── session-start.ts
│       ├── user-prompt-submit.ts
│       └── post-tool-use.ts
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── hooks/
│   │   └── hooks.json
│   └── scripts/
│       ├── session-start.js
│       ├── user-prompt-submit.js
│       └── post-tool-use.js
├── tests/
├── scripts/
│   └── build.ts
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

Each hook in `src/hooks/` gets bundled by esbuild into a single self-contained `.js` file in `plugin/scripts/`. External: `bun:sqlite`. The `plugin/` directory is what gets installed into `~/.claude/plugins/`.

## Error Handling

**Philosophy:** Wayfarer must never degrade the Claude Code experience. Every failure mode fails open.

**Hook-level:** All three hooks wrap their entire body in a try/catch. Any exception results in `process.exit(0)`. No error is worth blocking the user's session. Stderr gets a one-line message for debugging (`wayfarer: post-tool-use failed: ${error.message}`), but exit code stays 0.

**Database-level:**
- If `~/.wayfarer/` doesn't exist, create it on first access
- If the DB file is locked, WAL mode handles this — concurrent readers and one writer coexist without retries
- If migrations fail, log to stderr and exit 0 — the hook becomes a no-op until the issue is fixed

**Context injection (SessionStart):**
- If the search query fails or returns nothing, inject no context
- If FTS5 is unavailable, fall back to a plain `SELECT` with `LIKE` matching

**File path extraction:**
- Regex misses are fine — `files_touched` is best-effort enrichment, not a critical field
- No crash on malformed tool_input JSON — wrap the parse in try/catch, store `null` for files_touched

**Logging:** Write to `~/.wayfarer/wayfarer.log`, one line per event, append-only. No log rotation in MVP.
