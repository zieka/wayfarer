# AI Summarization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Stop hook that summarizes session observations via the Anthropic API and integrates summaries into context injection.

**Architecture:** Synchronous Stop hook reads observations from SQLite, sends to Anthropic API via raw `fetch()`, stores structured summary (narrative + file lists) back to SQLite. Context injection queries summaries first, falls back to raw observations.

**Tech Stack:** Bun, bun:sqlite, Anthropic Messages API (raw fetch), FTS5

**Design doc:** `docs/plans/2026-03-23-mvp-design.md` (base architecture)

---

### Task 1: Database migration for session_summaries

**Files:**
- Modify: `src/db.ts`
- Modify: `tests/db.test.ts`

**Step 1: Write the failing test**

Add to `tests/db.test.ts`:

```typescript
it('creates session_summaries table', () => {
  const db = getDb(TEST_DB);
  const tables = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries'"
  ).get() as { name: string } | null;
  expect(tables?.name).toBe('session_summaries');
  db.close();
});

it('creates session_summaries_fts virtual table', () => {
  const db = getDb(TEST_DB);
  const tables = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'"
  ).get() as { name: string } | null;
  expect(tables?.name).toBe('session_summaries_fts');
  db.close();
});

it('migrates existing v1 database to v2', () => {
  // Create a v1 database first
  const db1 = getDb(TEST_DB);
  db1.close();
  // Reopen — should still be v2
  const db2 = getDb(TEST_DB);
  const version = db2.query("PRAGMA user_version").get() as { user_version: number };
  expect(version.user_version).toBe(2);
  db2.close();
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/db.test.ts`
Expected: FAIL — session_summaries table does not exist

**Step 3: Add migration v2 to `src/db.ts`**

After the `if (version < 1)` block, add:

```typescript
if (version < 2) {
  db.run('BEGIN');
  db.run(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      summary TEXT NOT NULL,
      files_read TEXT,
      files_edited TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_summaries_session ON session_summaries(session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_summaries_project ON session_summaries(project, created_at DESC)');

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
      summary, files_read, files_edited,
      content='session_summaries', content_rowid='id'
    )
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(rowid, summary, files_read, files_edited)
      VALUES (new.id, new.summary, new.files_read, new.files_edited);
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, summary, files_read, files_edited)
      VALUES('delete', old.id, old.summary, old.files_read, old.files_edited);
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, summary, files_read, files_edited)
      VALUES('delete', old.id, old.summary, old.files_read, old.files_edited);
      INSERT INTO session_summaries_fts(rowid, summary, files_read, files_edited)
      VALUES (new.id, new.summary, new.files_read, new.files_edited);
    END
  `);

  db.run('PRAGMA user_version = 2');
  db.run('COMMIT');
}
```

Also update the existing idempotency test to expect version 2 instead of 1.

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/db.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: add session_summaries table with FTS5 (migration v2)"
```

---

### Task 2: Settings module

**Files:**
- Create: `src/settings.ts`
- Create: `tests/settings.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { getSettings, DEFAULT_MODEL } from '../src/settings';

const TEST_SETTINGS_DIR = '/tmp/wayfarer-test-settings';
const TEST_SETTINGS_FILE = `${TEST_SETTINGS_DIR}/settings.json`;

describe('getSettings', () => {
  afterEach(() => {
    try { unlinkSync(TEST_SETTINGS_FILE); } catch {}
  });

  it('returns default model when no settings file', () => {
    const settings = getSettings('/tmp/nonexistent/settings.json');
    expect(settings.model).toBe(DEFAULT_MODEL);
  });

  it('reads model from settings file', () => {
    mkdirSync(TEST_SETTINGS_DIR, { recursive: true });
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify({ model: 'claude-sonnet-4-5-20250514' }));
    const settings = getSettings(TEST_SETTINGS_FILE);
    expect(settings.model).toBe('claude-sonnet-4-5-20250514');
  });

  it('returns default model for invalid JSON', () => {
    mkdirSync(TEST_SETTINGS_DIR, { recursive: true });
    writeFileSync(TEST_SETTINGS_FILE, 'not json');
    const settings = getSettings(TEST_SETTINGS_FILE);
    expect(settings.model).toBe(DEFAULT_MODEL);
  });

  it('returns default model when model key missing', () => {
    mkdirSync(TEST_SETTINGS_DIR, { recursive: true });
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify({ other: 'value' }));
    const settings = getSettings(TEST_SETTINGS_FILE);
    expect(settings.model).toBe(DEFAULT_MODEL);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/settings.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './db';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

export interface Settings {
  model: string;
}

export function getSettings(settingsPath: string = SETTINGS_PATH): Settings {
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_MODEL,
    };
  } catch {
    return { model: DEFAULT_MODEL };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/settings.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/settings.ts tests/settings.test.ts
git commit -m "feat: add settings module with configurable model"
```

---

### Task 3: Summarization module

**Files:**
- Create: `src/summarize.ts`
- Create: `tests/summarize.test.ts`

**Step 1: Write the failing test**

Test the observation formatting and response parsing (not the API call itself):

```typescript
import { describe, it, expect } from 'bun:test';
import { formatObservations, parseSummaryResponse } from '../src/summarize';

describe('formatObservations', () => {
  it('formats observations into a compact list', () => {
    const result = formatObservations('fix the auth bug', [
      { tool_name: 'Read', tool_input: 'src/auth.ts', tool_output: 'file contents' },
      { tool_name: 'Edit', tool_input: 'src/auth.ts', tool_output: 'edited' },
    ]);
    expect(result).toContain('fix the auth bug');
    expect(result).toContain('[Read]');
    expect(result).toContain('[Edit]');
    expect(result).toContain('src/auth.ts');
  });

  it('truncates long tool inputs', () => {
    const longInput = 'x'.repeat(500);
    const result = formatObservations('test', [
      { tool_name: 'Bash', tool_input: longInput, tool_output: 'ok' },
    ]);
    expect(result.length).toBeLessThan(600);
  });
});

describe('parseSummaryResponse', () => {
  it('parses valid JSON response', () => {
    const json = JSON.stringify({
      summary: 'Fixed the auth bug',
      files_read: ['src/auth.ts'],
      files_edited: ['src/auth.ts', 'tests/auth.test.ts'],
    });
    const result = parseSummaryResponse(json);
    expect(result.summary).toBe('Fixed the auth bug');
    expect(result.files_read).toBe('src/auth.ts');
    expect(result.files_edited).toBe('src/auth.ts,tests/auth.test.ts');
  });

  it('handles plain text response', () => {
    const result = parseSummaryResponse('Fixed the auth bug by adding expiry check');
    expect(result.summary).toBe('Fixed the auth bug by adding expiry check');
    expect(result.files_read).toBeNull();
    expect(result.files_edited).toBeNull();
  });

  it('handles malformed JSON gracefully', () => {
    const result = parseSummaryResponse('{ broken json');
    expect(result.summary).toBe('{ broken json');
    expect(result.files_read).toBeNull();
    expect(result.files_edited).toBeNull();
  });

  it('handles JSON with missing fields', () => {
    const json = JSON.stringify({ summary: 'Did stuff' });
    const result = parseSummaryResponse(json);
    expect(result.summary).toBe('Did stuff');
    expect(result.files_read).toBeNull();
    expect(result.files_edited).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/summarize.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
import { getSettings } from './settings';

const SYSTEM_PROMPT = `You are a concise technical summarizer. Given a list of tool observations from a coding session, produce a JSON response with three fields:
- "summary": 2-3 sentence narrative of what was accomplished
- "files_read": array of file paths that were read
- "files_edited": array of file paths that were created or modified

Focus on what changed and why, not the mechanics of each tool call. Respond with only the JSON object, no markdown fencing.`;

const MAX_INPUT_LENGTH = 300;

interface ObservationInput {
  tool_name: string;
  tool_input: string;
  tool_output: string;
}

export interface SummaryResult {
  summary: string;
  files_read: string | null;
  files_edited: string | null;
}

export function formatObservations(prompt: string | null, observations: ObservationInput[]): string {
  const lines = observations.map((obs, i) => {
    const input = obs.tool_input.length > MAX_INPUT_LENGTH
      ? obs.tool_input.slice(0, MAX_INPUT_LENGTH) + '...'
      : obs.tool_input;
    return `${i + 1}. [${obs.tool_name}] ${input}`;
  });

  const header = prompt ? `Session prompt: "${prompt}"\n\n` : '';
  return header + lines.join('\n');
}

export function parseSummaryResponse(text: string): SummaryResult {
  try {
    const parsed = JSON.parse(text);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : text,
      files_read: Array.isArray(parsed.files_read) ? parsed.files_read.join(',') : null,
      files_edited: Array.isArray(parsed.files_edited) ? parsed.files_edited.join(',') : null,
    };
  } catch {
    return { summary: text, files_read: null, files_edited: null };
  }
}

export async function callAnthropic(content: string, model?: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const selectedModel = model ?? getSettings().model;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/summarize.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/summarize.ts tests/summarize.test.ts
git commit -m "feat: add summarization module with Anthropic API integration"
```

---

### Task 4: Stop hook

**Files:**
- Create: `src/hooks/stop.ts`
- Create: `tests/hooks/stop.test.ts`

**Step 1: Write the failing test**

Test the handler logic with a mock API (we test the real API in smoke tests):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { getDb } from '../../src/db';
import { handleStop } from '../../src/hooks/stop';

const TEST_DB = '/tmp/wayfarer-test-stop.db';

describe('handleStop', () => {
  beforeEach(() => {
    const db = getDb(TEST_DB);
    const now = Math.floor(Date.now() / 1000);
    db.run(
      'INSERT INTO sessions (session_id, project, prompt, started_at) VALUES (?, ?, ?, ?)',
      ['sess-1', '/project', 'fix auth bug', now - 60],
    );
    db.run(
      `INSERT INTO observations (session_id, project, tool_name, tool_input, tool_output, files_touched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['sess-1', '/project', 'Edit', 'src/auth.ts', 'edited', 'src/auth.ts', now - 30],
    );
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('skips summarization when no API key', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await handleStop({ session_id: 'sess-1', cwd: '/project' }, TEST_DB);
      expect(result).toEqual({ continue: true });
      // No summary should be stored
      const db = getDb(TEST_DB);
      const summary = db.query('SELECT * FROM session_summaries WHERE session_id = ?').get('sess-1');
      expect(summary).toBeNull();
      db.close();
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('skips summarization when no observations', async () => {
    const db = getDb(TEST_DB);
    db.run('DELETE FROM observations WHERE session_id = ?', ['sess-1']);
    db.close();

    const result = await handleStop({ session_id: 'sess-1', cwd: '/project' }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });

  it('returns continue: true always', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await handleStop({ session_id: 'sess-1', cwd: '/project' }, TEST_DB);
    expect(result).toEqual({ continue: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/hooks/stop.test.ts`
Expected: FAIL — `handleStop` not found

**Step 3: Write the implementation**

```typescript
import { readStdin } from '../stdin';
import { getDb } from '../db';
import { formatObservations, parseSummaryResponse, callAnthropic } from '../summarize';
import type { HookResponse } from './user-prompt-submit';

export async function handleStop(
  input: Record<string, unknown>,
  dbPath?: string,
): Promise<HookResponse> {
  const sessionId = (input.session_id ?? input.id ?? input.sessionId) as string;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('wayfarer: skipping summarization (no API key)');
    return { continue: true };
  }

  const db = getDb(dbPath);
  try {
    // Get session prompt
    const session = db.query('SELECT prompt, project FROM sessions WHERE session_id = ?')
      .get(sessionId) as { prompt: string | null; project: string } | null;

    if (!session) return { continue: true };

    // Get all observations for this session
    const observations = db.query(
      'SELECT tool_name, tool_input, tool_output FROM observations WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as Array<{ tool_name: string; tool_input: string; tool_output: string }>;

    if (observations.length === 0) return { continue: true };

    // Format and call API
    const content = formatObservations(session.prompt, observations);
    const responseText = await callAnthropic(content);
    const result = parseSummaryResponse(responseText);

    // Store summary
    db.run(
      `INSERT OR REPLACE INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, session.project, result.summary, result.files_read, result.files_edited, Math.floor(Date.now() / 1000)],
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
      const result = await handleStop(input);
      process.stdout.write(JSON.stringify(result));
    }
  } catch (e) {
    console.error(`wayfarer: stop failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/hooks/stop.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/hooks/stop.ts tests/hooks/stop.test.ts
git commit -m "feat: add Stop hook with AI summarization"
```

---

### Task 5: Update context injection to use summaries

**Files:**
- Modify: `src/context.ts`
- Modify: `tests/context.test.ts`

**Step 1: Write the failing test**

Add to `tests/context.test.ts`:

```typescript
describe('buildContext with summaries', () => {
  beforeEach(() => {
    const db = getDb(TEST_DB);
    seedData(db);
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO session_summaries (session_id, project, summary, files_read, files_edited, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['s1', '/project', 'Fixed the auth token expiry bug. Added validation and tests.', 'src/auth.ts', 'src/auth.ts,tests/auth.test.ts', now - 3600],
    );
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('prefers summaries over raw observations', () => {
    const ctx = buildContext('/project', undefined, TEST_DB);
    expect(ctx).toContain('Fixed the auth token expiry bug');
    // Should NOT contain the raw observation table format
    expect(ctx).not.toContain('| Time | Tool |');
  });

  it('falls back to observations when no summaries', () => {
    const db = getDb(TEST_DB);
    db.run('DELETE FROM session_summaries');
    db.close();
    const ctx = buildContext('/project', undefined, TEST_DB);
    expect(ctx).toContain('| Time | Tool |');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test tests/context.test.ts`
Expected: FAIL — summaries not queried, still showing observation table

**Step 3: Update `src/context.ts`**

Add a summary query path at the top of `buildContext()`. When summaries exist for the project, format them as narrative blocks. When no summaries exist, fall through to the existing observation query.

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

interface SummaryRow {
  summary: string;
  files_read: string | null;
  files_edited: string | null;
  created_at: number;
}

function buildSummaryContext(rows: SummaryRow[]): string {
  const header = '## Recent work in this project\n\n';
  const blocks = rows.map((row) => {
    const time = formatTimeAgo(row.created_at);
    const files = [row.files_read, row.files_edited]
      .filter(Boolean)
      .join(',')
      .split(',')
      .filter((f, i, arr) => f && arr.indexOf(f) === i)
      .join(', ');
    const filesLine = files ? `\nFiles: ${files}` : '';
    return `**${time}:** ${row.summary}${filesLine}`;
  }).join('\n\n');

  return `<wayfarer-context>\n${header}${blocks}\n</wayfarer-context>`;
}

export function buildContext(
  project: string,
  query: string | undefined,
  dbPath?: string,
): string | null {
  const db = getDb(dbPath);
  try {
    // Try summaries first (unless we have a specific search query)
    if (!query) {
      const summaries = db.query(`
        SELECT summary, files_read, files_edited, created_at
        FROM session_summaries
        WHERE project = ?
        ORDER BY created_at DESC
        LIMIT 20
      `).all(project) as SummaryRow[];

      if (summaries.length > 0) {
        return buildSummaryContext(summaries);
      }
    }

    // Fall back to raw observations
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
Expected: All tests PASS (existing + new)

**Step 5: Commit**

```bash
git add src/context.ts tests/context.test.ts
git commit -m "feat: context injection prefers summaries over raw observations"
```

---

### Task 6: Update hooks.json and build script

**Files:**
- Modify: `plugin/hooks/hooks.json`
- Modify: `scripts/build.ts`

**Step 1: Add Stop hook to hooks.json**

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
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/stop.js\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

**Step 2: Add `stop` to build script**

In `scripts/build.ts`, add `'stop'` to the hooks array:

```typescript
const hooks = [
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'stop',
];
```

**Step 3: Build and verify**

Run: `cd /Users/kylescully/Repos/wayfarer && bun run build`
Expected: `Built 4 hooks to plugin/scripts/`

Run: `head -1 plugin/scripts/stop.js`
Expected: `#!/usr/bin/env bun`

**Step 4: Commit**

```bash
git add plugin/hooks/hooks.json scripts/build.ts
git commit -m "chore: add Stop hook to build and plugin configuration"
```

---

### Task 7: Dev install and full test suite

**Step 1: Run all tests**

Run: `cd /Users/kylescully/Repos/wayfarer && bun test`
Expected: All tests PASS

**Step 2: Reinstall plugin**

Run: `cd /Users/kylescully/Repos/wayfarer && bun run dev:install`
Expected: Wayfarer v0.1.0 installed successfully

**Step 3: Verify**

Run: `ls ~/.claude/plugins/marketplaces/wayfarer/scripts/`
Expected: 4 files: `session-start.js`, `user-prompt-submit.js`, `post-tool-use.js`, `stop.js`
