# Wayfarer

Persistent memory for Claude Code.

## What it does

Wayfarer captures what you do across Claude Code sessions -- tools used, files touched, decisions made -- and brings relevant context back when you return to a project. It uses FTS5 full-text search and vector search (BGE-small-en-v1.5 via fastembed) to surface past work, and generates AI-powered session summaries so future sessions start with useful context instead of a blank slate.

## Install

**Prerequisites:** [Bun](https://bun.sh) >= 1.0

```bash
bun install && bun run build && bun run dev:install
```

The `fastembed` dependency requires `onnxruntime-node`, which is listed in `trustedDependencies` in `package.json`. Bun will prompt you to allow its install scripts on first run.

## How it works

Wayfarer runs entirely through Claude Code hooks -- no daemon, no HTTP server. Each hook is a short-lived Bun process that reads stdin JSON, writes/reads SQLite, and outputs stdout JSON.

| Hook | What it does |
|---|---|
| `SessionStart` | Queries past session summaries and observations for the current project, injecting them as context so Claude remembers previous work |
| `UserPromptSubmit` | Captures the user's prompt text for the session record |
| `PostToolUse` | Records tool observations (tool name, input, files touched) to SQLite |
| `Stop` | Fires a detached summarization worker that uses Claude to generate a session summary with files read and edited |

## Skills

- `/wayfarer-search` -- Search past work across sessions using FTS5. Ask "what did I do with X?" and get results from summaries and observations.

## Data

- **Database:** `~/.wayfarer/wayfarer.db` (SQLite, WAL mode)
- **Model cache:** `~/.wayfarer/models/` (BGE-small-en-v1.5 ONNX model, downloaded on first use)

## Development

```bash
# Build hooks to plugin/scripts/
bun run build

# Run tests
bun test

# Build and install plugin to ~/.claude/plugins/
bun run dev:install
```

## License

MIT
