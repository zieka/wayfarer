# Wayfarer MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Claude Code plugin that captures tool usage and prompts to SQLite and injects relevant context into future sessions — no daemon, no HTTP, hooks only.

**Architecture:** Each hook is a standalone Bun script. Reads JSON from stdin, writes/reads SQLite via `bun:sqlite`, outputs JSON to stdout. WAL mode handles concurrency. FTS5 provides search with recency weighting.

**Tech Stack:** Bun, TypeScript, bun:sqlite, esbuild, FTS5

**Design doc:** `docs/plans/2026-03-23-mvp-design.md`

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `CLAUDE.md`

**Step 1: Initialize package.json**

```json
{
  "name": "wayfarer",
  "version": "0.1.0",
  "description": "Persistent memory for Claude Code — lightweight, no daemon",
  "type": "module",
  "scripts": {
    "build": "bun run scripts/build.ts",
    "test": "bun test"
  },
  "devDependencies": {
    "esbuild": "^0.25.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun-types"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "plugin"]
}
```

**Step 3: Create CLAUDE.md**

```markdown
# Wayfarer

Persistent memory plugin for Claude Code. Captures observations to SQLite, injects relevant context into future sessions.

## Architecture

- Hooks are the entire runtime — no daemon, no HTTP server
- Each hook is a short-lived Bun process: read stdin JSON, write/read SQLite, output stdout JSON
- SQLite in WAL mode at `~/.wayfarer/wayfarer.db`
- FTS5 for search with recency-weighted scoring

## Build

\`\`\`bash
bun install && bun run build
\`\`\`

## Test

\`\`\`bash
bun test
\`\`\`

## File Layout

- `src/` — TypeScript source
- `plugin/` — Built plugin (installed to `~/.claude/plugins/`)
- `tests/` — Test files
```

**Step 4: Install dependencies**

Run: `cd /Users/kylescully/Repos/wayfarer && bun install`

**Step 5: Commit**

```bash
git add package.json tsconfig.json CLAUDE.md bun.lockb
git commit -m "chore: scaffold wayfarer project"
```

---

### Task 2: Plugin manifest and hooks configuration

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `plugin/hooks/hooks.json`

**Step 1: Create plugin.json**

```json
{
  "name": "wayfarer",
  "version": "0.1.0",
  "description": "Persistent memory for Claude Code — lightweight, no daemon",
  "author": {
    "name": "Kyle Scully"
  },
  "license": "MIT"
}
```

**Step 2: Create hooks.json**

The hooks invoke Bun directly on the built scripts. `$CLAUDE_PLUGIN_ROOT` is set by Claude Code to the plugin's install directory.

```json
{
  "description": "Wayfarer memory hooks",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-use.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Step 3: Commit**

```bash
git add plugin/
git commit -m "chore: add plugin manifest and hook configuration"
```

---

### Task 3: Build script

**Files:**
- Create: `scripts/build.ts`

**Step 1: Write the build script**

Uses esbuild to bundle each hook into a standalone `.js` file in `plugin/scripts/`.

```typescript
import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('plugin/scripts', { recursive: true });

const hooks = [
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
];

for (const hook of hooks) {
  await build({
    entryPoints: [`src/hooks/${hook}.ts`],
    bundle: true,
    outfile: `plugin/scripts/${hook}.js`,
    platform: 'node',
    target: 'esnext',
    format: 'esm',
    minify: false,
    external: ['bun:sqlite'],
    banner: { js: '#!/usr/bin/env bun' },
  });
}

console.log(`Built ${hooks.length} hooks to plugin/scripts/`);
```

**Step 2: Verify build script compiles (no source files yet, so don't run)**

Run: `bunx tsc --noEmit scripts/build.ts`
Expected: May warn about missing source files, that's fine.

**Step 3: Commit**

```bash
git add scripts/build.ts
git commit -m "chore: add esbuild script for hook bundling"
```

---

### Task 4: Database module

**Files:**
- Create: `src/db.ts`
- Create: `tests/db.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb, DB_PATH } from '../src/db';

const TEST_DB = '/tmp/wayfarer-test.db';

describe('getDb', () => {
  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('creates database with WAL mode', () => {
    const db = getDb(TEST_DB);
    const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe('wal');
    db.close();
  });

  it('creates sessions table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('sessions');
    db.close();
  });

  it('creates observations table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('observations');
    db.close();
  });

  it('creates FTS5 virtual table', () => {
    const db = getDb(TEST_DB);
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).get() as { name: string } | null;
    expect(tables?.name).toBe('observations_fts');
    db.close();
  });

  it('runs migrations idempotently', () => {
    const db1 = getDb(TEST_DB);
    db1.close();
    const db2 = getDb(TEST_DB);
    const version = db2.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(1);
    db2.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/db.test.ts`
Expected: FAIL — `getDb` not found

**Step 3: Write the implementation**

```typescript
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export const DATA_DIR = join(homedir(), '.wayfarer');
export const DB_PATH = join(DATA_DIR, 'wayfarer.db');

export function getDb(dbPath: string = DB_PATH): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: version } = db.query('PRAGMA user_version').get() as { user_version: number };

  if (version < 1) {
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        prompt TEXT,
        started_at INTEGER NOT NULL,
        status TEXT CHECK(status IN ('active','completed')) NOT NULL DEFAULT 'active'
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, started_at DESC)');

    db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        tool_output TEXT NOT NULL,
        files_touched TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project, created_at DESC)');

    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        tool_name, tool_input, tool_output, files_touched,
        content='observations', content_rowid='id'
      )
    `);

    // Triggers to keep FTS in sync
    db.run(`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, tool_name, tool_input, tool_output, files_touched)
        VALUES (new.id, new.tool_name, new.tool_input, new.tool_output, new.files_touched);
      END
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, tool_name, tool_input, tool_output, files_touched)
        VALUES('delete', old.id, old.tool_name, old.tool_input, old.tool_output, old.files_touched);
      END
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, tool_name, tool_input, tool_output, files_touched)
        VALUES('delete', old.id, old.tool_name, old.tool_input, old.tool_output, old.files_touched);
        INSERT INTO observations_fts(rowid, tool_name, tool_input, tool_output, files_touched)
        VALUES (new.id, new.tool_name, new.tool_input, new.tool_output, new.files_touched);
      END
    `);

    db.run('PRAGMA user_version = 1');
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/db.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: add database module with schema and FTS5"
```

---

### Task 5: File path extraction utility

**Files:**
- Create: `src/files.ts`
- Create: `tests/files.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'bun:test';
import { extractFilePaths } from '../src/files';

describe('extractFilePaths', () => {
  it('extracts absolute paths', () => {
    const input = '{"file_path": "/Users/kyle/src/auth.ts"}';
    expect(extractFilePaths(input)).toContain('/Users/kyle/src/auth.ts');
  });

  it('extracts relative paths with extensions', () => {
    const input = '{"path": "src/components/Button.tsx"}';
    expect(extractFilePaths(input)).toContain('src/components/Button.tsx');
  });

  it('extracts multiple paths', () => {
    const input = 'Edited src/a.ts and src/b.ts';
    const paths = extractFilePaths(input);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/b.ts');
  });

  it('returns null for no paths', () => {
    expect(extractFilePaths('just some text')).toBeNull();
  });

  it('deduplicates paths', () => {
    const input = 'src/a.ts and src/a.ts again';
    const paths = extractFilePaths(input);
    expect(paths).toBe('src/a.ts');
  });

  it('handles JSON-stringified tool input', () => {
    const input = JSON.stringify({ file_path: '/tmp/test.py', content: 'print("hello")' });
    expect(extractFilePaths(input)).toContain('/tmp/test.py');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/files.test.ts`
Expected: FAIL — `extractFilePaths` not found

**Step 3: Write the implementation**

```typescript
const FILE_PATH_RE = /(?:\/[\w.-]+)+\.[\w]+|(?:[\w.-]+\/)+[\w.-]+\.[\w]+/g;

export function extractFilePaths(input: string): string | null {
  const matches = input.match(FILE_PATH_RE);
  if (!matches || matches.length === 0) return null;
  const unique = [...new Set(matches)];
  return unique.join(',');
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/files.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/files.ts tests/files.test.ts
git commit -m "feat: add file path extraction from tool inputs"
```

---

### Task 6: Stdin reading utility

**Files:**
- Create: `src/stdin.ts`
- Create: `tests/stdin.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'bun:test';
import { parseStdin } from '../src/stdin';

describe('parseStdin', () => {
  it('parses valid JSON', () => {
    const result = parseStdin('{"session_id": "abc", "cwd": "/tmp"}');
    expect(result).toEqual({ session_id: 'abc', cwd: '/tmp' });
  });

  it('returns null for empty input', () => {
    expect(parseStdin('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseStdin('not json')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/stdin.test.ts`
Expected: FAIL — `parseStdin` not found

**Step 3: Write the implementation**

Claude Code writes JSON to stdin but doesn't close the stream, so we read until we find a complete JSON object.

```typescript
export function parseStdin(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export async function readStdin(): Promise<Record<string, unknown> | null> {
  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      chunks.push(text);
      // Try parsing after each chunk — Claude Code doesn't close stdin
      const result = parseStdin(chunks.join(''));
      if (result) return result;
    }
  } catch {
    // stdin closed or errored
  }

  return parseStdin(chunks.join(''));
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/stdin.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/stdin.ts tests/stdin.test.ts
git commit -m "feat: add stdin JSON reader for hook input"
```

---

### Task 7: UserPromptSubmit hook

**Files:**
- Create: `src/hooks/user-prompt-submit.ts`
- Create: `tests/hooks/user-prompt-submit.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handleUserPromptSubmit } from '../../src/hooks/user-prompt-submit';

const TEST_DB = '/tmp/wayfarer-test-ups.db';

describe('handleUserPromptSubmit', () => {
  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('creates a session record', () => {
    const db = getDb(TEST_DB);
    handleUserPromptSubmit({
      session_id: 'sess-1',
      cwd: '/Users/kyle/project',
      prompt: 'fix the auth bug',
    }, TEST_DB);

    const session = db.query('SELECT * FROM sessions WHERE session_id = ?').get('sess-1') as any;
    expect(session).not.toBeNull();
    expect(session.project).toBe('/Users/kyle/project');
    expect(session.prompt).toBe('fix the auth bug');
    expect(session.status).toBe('active');
    db.close();
  });

  it('is idempotent for same session_id', () => {
    handleUserPromptSubmit({ session_id: 'sess-1', cwd: '/tmp', prompt: 'first' }, TEST_DB);
    handleUserPromptSubmit({ session_id: 'sess-1', cwd: '/tmp', prompt: 'second' }, TEST_DB);

    const db = getDb(TEST_DB);
    const count = db.query('SELECT COUNT(*) as c FROM sessions WHERE session_id = ?').get('sess-1') as any;
    expect(count.c).toBe(1);
    db.close();
  });

  it('returns continue: true', () => {
    const result = handleUserPromptSubmit({
      session_id: 'sess-2',
      cwd: '/tmp',
      prompt: 'hello',
    }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/hooks/user-prompt-submit.test.ts`
Expected: FAIL — `handleUserPromptSubmit` not found

**Step 3: Write the implementation**

The exported `handleUserPromptSubmit` is the testable core. The file's top-level code is the hook entry point that reads stdin and calls it.

```typescript
import { readStdin } from '../stdin';
import { getDb } from '../db';

export interface HookResponse {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
}

export function handleUserPromptSubmit(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;
  const project = (input.cwd ?? process.cwd()) as string;
  const prompt = (input.prompt ?? null) as string | null;

  const db = getDb(dbPath);
  try {
    db.run(
      'INSERT OR IGNORE INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
      [sessionId, project, prompt, Math.floor(Date.now() / 1000)],
    );
  } finally {
    db.close();
  }

  return { continue: true };
}

// Hook entry point — only runs when executed directly
if (import.meta.main) {
  try {
    const input = await readStdin();
    if (input) {
      const result = handleUserPromptSubmit(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: user-prompt-submit failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/hooks/user-prompt-submit.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/hooks/user-prompt-submit.ts tests/hooks/user-prompt-submit.test.ts
git commit -m "feat: add UserPromptSubmit hook"
```

---

### Task 8: PostToolUse hook

**Files:**
- Create: `src/hooks/post-tool-use.ts`
- Create: `tests/hooks/post-tool-use.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handlePostToolUse } from '../../src/hooks/post-tool-use';

const TEST_DB = '/tmp/wayfarer-test-ptu.db';

describe('handlePostToolUse', () => {
  beforeEach(() => {
    // Create session first (foreign key constraint)
    const db = getDb(TEST_DB);
    db.run(
      'INSERT OR IGNORE INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
      ['sess-1', '/tmp/project', 'test prompt', Math.floor(Date.now() / 1000)],
    );
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('stores an observation', () => {
    handlePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp/project',
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: '/tmp/project/src/auth.ts' }),
      tool_response: 'file contents here',
    }, TEST_DB);

    const db = getDb(TEST_DB);
    const obs = db.query('SELECT * FROM observations WHERE session_id = ?').get('sess-1') as any;
    expect(obs).not.toBeNull();
    expect(obs.tool_name).toBe('Read');
    expect(obs.files_touched).toContain('src/auth.ts');
    db.close();
  });

  it('populates FTS index', () => {
    handlePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp/project',
      tool_name: 'Edit',
      tool_input: JSON.stringify({ file_path: '/tmp/project/src/auth.ts' }),
      tool_response: 'edited successfully',
    }, TEST_DB);

    const db = getDb(TEST_DB);
    const fts = db.query(
      "SELECT * FROM observations_fts WHERE observations_fts MATCH 'auth'"
    ).get() as any;
    expect(fts).not.toBeNull();
    db.close();
  });

  it('handles missing session gracefully', () => {
    // session_id that doesn't exist — should still not crash
    const result = handlePostToolUse({
      session_id: 'nonexistent',
      cwd: '/tmp',
      tool_name: 'Read',
      tool_input: '{}',
      tool_response: 'ok',
    }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });

  it('returns continue: true', () => {
    const result = handlePostToolUse({
      session_id: 'sess-1',
      cwd: '/tmp/project',
      tool_name: 'Bash',
      tool_input: 'ls',
      tool_response: 'file1 file2',
    }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/hooks/post-tool-use.test.ts`
Expected: FAIL — `handlePostToolUse` not found

**Step 3: Write the implementation**

```typescript
import { readStdin } from '../stdin';
import { getDb } from '../db';
import { extractFilePaths } from '../files';
import type { HookResponse } from './user-prompt-submit';

export function handlePostToolUse(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;
  const project = (input.cwd ?? process.cwd()) as string;
  const toolName = (input.tool_name ?? 'unknown') as string;
  const toolInput = typeof input.tool_input === 'string'
    ? input.tool_input
    : JSON.stringify(input.tool_input ?? '');
  const toolOutput = typeof input.tool_response === 'string'
    ? input.tool_response
    : JSON.stringify(input.tool_response ?? '');

  const filesTouched = extractFilePaths(toolInput);

  const db = getDb(dbPath);
  try {
    // Ensure session exists (create if hook ordering was unexpected)
    db.run(
      'INSERT OR IGNORE INTO sessions (session_id, project, started_at) VALUES (?, ?, ?)',
      [sessionId, project, Math.floor(Date.now() / 1000)],
    );

    db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, project, toolName, toolInput, toolOutput, filesTouched, Math.floor(Date.now() / 1000)],
    );
  } finally {
    db.close();
  }

  return { continue: true };
}

if (import.meta.main) {
  try {
    const input = await readStdin();
    if (input) {
      const result = handlePostToolUse(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: post-tool-use failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/hooks/post-tool-use.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/hooks/post-tool-use.ts tests/hooks/post-tool-use.test.ts
git commit -m "feat: add PostToolUse hook"
```

---

### Task 9: Context injection module

**Files:**
- Create: `src/context.ts`
- Create: `tests/context.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../src/db';
import { buildContext } from '../src/context';

const TEST_DB = '/tmp/wayfarer-test-ctx.db';

function seedData(db: ReturnType<typeof getDb>) {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    'INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
    ['s1', '/project', 'fix auth', now - 86400],
  );
  db.run(
    `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['s1', '/project', 'Edit', 'edited auth.ts', 'success', 'src/auth.ts', now - 86400],
  );
  db.run(
    `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['s1', '/project', 'Bash', 'npm test', 'all passed', null, now - 3600],
  );
}

describe('buildContext', () => {
  beforeEach(() => {
    const db = getDb(TEST_DB);
    seedData(db);
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('returns recent observations for project with no query', () => {
    const ctx = buildContext('/project', undefined, TEST_DB);
    expect(ctx).toContain('auth.ts');
    expect(ctx).toContain('Edit');
  });

  it('returns null for empty database', () => {
    const emptyDb = '/tmp/wayfarer-test-ctx-empty.db';
    const ctx = buildContext('/project', undefined, emptyDb);
    try { unlinkSync(emptyDb); } catch {}
    try { unlinkSync(emptyDb + '-wal'); } catch {}
    try { unlinkSync(emptyDb + '-shm'); } catch {}
    expect(ctx).toBeNull();
  });

  it('searches with FTS when query provided', () => {
    const ctx = buildContext('/project', 'auth', TEST_DB);
    expect(ctx).toContain('auth');
  });

  it('wraps output in wayfarer-context tags', () => {
    const ctx = buildContext('/project', undefined, TEST_DB);
    expect(ctx).toContain('<wayfarer-context>');
    expect(ctx).toContain('</wayfarer-context>');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/context.test.ts`
Expected: FAIL — `buildContext` not found

**Step 3: Write the implementation**

```typescript
import { getDb } from './db';

const MAX_RESULTS = 20;
const MAX_SNIPPET_LENGTH = 200;

function formatTimeAgo(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

interface ObservationRow {
  id: number;
  tool_name: string;
  tool_input: string;
  files_touched: string | null;
  created_at: number;
  context?: string;
}

export function buildContext(
  project: string,
  query: string | undefined,
  dbPath?: string,
): string | null {
  const db = getDb(dbPath);
  try {
    let rows: ObservationRow[];

    if (query) {
      const now = Math.floor(Date.now() / 1000);
      rows = db.query(`
        SELECT o.id, o.tool_name, o.files_touched, o.created_at,
               snippet(observations_fts, 1, '', '', '...', 32) as context
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
          AND o.project = ?
        ORDER BY (rank * -1.0) * (1.0 / (1.0 + (? - o.created_at) / 86400.0)) DESC
        LIMIT ?
      `).all(query, project, now, MAX_RESULTS) as ObservationRow[];
    } else {
      rows = db.query(`
        SELECT id, tool_name, tool_input, files_touched, created_at
        FROM observations
        WHERE project = ?
        ORDER BY created_at DESC
        LIMIT 10
      `).all(project) as ObservationRow[];
    }

    if (rows.length === 0) return null;

    const header = '## Recent relevant work in this project\n\n| Time | Tool | Files | Context |\n|------|------|-------|---------|\n';
    const tableRows = rows.map((row) => {
      const time = formatTimeAgo(row.created_at);
      const files = row.files_touched ?? '';
      const context = truncate(row.context ?? row.tool_input ?? '', MAX_SNIPPET_LENGTH);
      return `| ${time} | ${row.tool_name} | ${files} | ${context} |`;
    }).join('\n');

    return `<wayfarer-context>\n${header}${tableRows}\n</wayfarer-context>`;
  } finally {
    db.close();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/context.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/context.ts tests/context.test.ts
git commit -m "feat: add context injection with recency-weighted FTS5 search"
```

---

### Task 10: SessionStart hook

**Files:**
- Create: `src/hooks/session-start.ts`
- Create: `tests/hooks/session-start.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handleSessionStart } from '../../src/hooks/session-start';

const TEST_DB = '/tmp/wayfarer-test-ss.db';

describe('handleSessionStart', () => {
  beforeEach(() => {
    const db = getDb(TEST_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run(
      'INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
      ['old-sess', '/project', 'previous work', now - 3600],
    );
    db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['old-sess', '/project', 'Edit', 'edited auth.ts', 'done', 'src/auth.ts', now - 3600],
    );
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('returns context when observations exist', () => {
    const result = handleSessionStart({ session_id: 'new-sess', cwd: '/project' }, TEST_DB);
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(result.hookSpecificOutput?.additionalContext).toContain('wayfarer-context');
  });

  it('returns no context for empty project', () => {
    const result = handleSessionStart({ session_id: 'new-sess', cwd: '/other-project' }, TEST_DB);
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('always returns continue: true', () => {
    const result = handleSessionStart({ session_id: 'new-sess', cwd: '/whatever' }, TEST_DB);
    expect(result.continue).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/hooks/session-start.test.ts`
Expected: FAIL — `handleSessionStart` not found

**Step 3: Write the implementation**

```typescript
import { readStdin } from '../stdin';
import { buildContext } from '../context';
import type { HookResponse } from './user-prompt-submit';

export function handleSessionStart(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const project = (input.cwd ?? process.cwd()) as string;

  const context = buildContext(project, undefined, dbPath);

  if (context) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    };
  }

  return { continue: true };
}

if (import.meta.main) {
  try {
    const input = await readStdin();
    const result = handleSessionStart(input ?? { cwd: process.cwd() });
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    console.error(`wayfarer: session-start failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/hooks/session-start.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/hooks/session-start.ts tests/hooks/session-start.test.ts
git commit -m "feat: add SessionStart hook with context injection"
```

---

### Task 11: Build and verify end-to-end

**Files:**
- No new files — verify existing build and test pipeline

**Step 1: Run all tests**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test`
Expected: All tests PASS

**Step 2: Run the build**

Run: `cd /Users/kylescully/Repos/wayfarer && bun run build`
Expected: 3 files created in `plugin/scripts/`

**Step 3: Verify built files exist and have shebangs**

Run: `head -1 plugin/scripts/session-start.js plugin/scripts/user-prompt-submit.js plugin/scripts/post-tool-use.js`
Expected: Each starts with `#!/usr/bin/env bun`

**Step 4: Add plugin/scripts to .gitignore (built artifacts)**

Create `.gitignore`:

```
node_modules/
dist/
plugin/scripts/
bun.lockb
```

**Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: add gitignore for built artifacts"
```

---

### Task 12: Smoke test with real stdin

**Step 1: Test UserPromptSubmit hook with piped stdin**

Run:
```bash
echo '{"session_id":"test-1","cwd":"/tmp/test","prompt":"hello world"}' | bun plugin/scripts/user-prompt-submit.js
```
Expected: `{"continue":true}`

**Step 2: Test PostToolUse hook with piped stdin**

Run:
```bash
echo '{"session_id":"test-1","cwd":"/tmp/test","tool_name":"Read","tool_input":"{\"file_path\":\"/tmp/test/foo.ts\"}","tool_response":"contents"}' | bun plugin/scripts/post-tool-use.js
```
Expected: `{"continue":true}`

**Step 3: Test SessionStart hook with piped stdin**

Run:
```bash
echo '{"session_id":"test-2","cwd":"/tmp/test"}' | bun plugin/scripts/session-start.js
```
Expected: JSON with `hookSpecificOutput` containing `wayfarer-context`

**Step 4: Verify database contents**

Run:
```bash
bun -e "
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';
const db = new Database(join(homedir(), '.wayfarer', 'wayfarer.db'));
console.log('Sessions:', db.query('SELECT * FROM sessions').all());
console.log('Observations:', db.query('SELECT id, session_id, tool_name, files_touched FROM observations').all());
"
```
Expected: Shows the test session and observation

**Step 5: Clean up test data**

Run:
```bash
rm -f ~/.wayfarer/wayfarer.db ~/.wayfarer/wayfarer.db-wal ~/.wayfarer/wayfarer.db-shm
```
