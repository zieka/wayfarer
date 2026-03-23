---
name: wayfarer-search
description: "Search past work across sessions. Use when user asks about history, previous sessions, or 'what did I do with X'."
---

# Wayfarer Search

Search your persistent memory across all Claude Code sessions.

## When to Use

- User asks "what did I do with X?"
- User references past work or previous sessions
- User wants to find code changes, files touched, or decisions made

## How to Search

Run a query against the wayfarer database:

```bash
bun -e "
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';

const db = new Database(join(homedir(), '.wayfarer', 'wayfarer.db'));
const query = '$ARGUMENTS';
const project = process.cwd();

// Search summaries first
const summaries = db.query(\`
  SELECT s.summary, s.files_read, s.files_edited, s.created_at,
         ss.prompt, ss.project
  FROM session_summaries_fts
  JOIN session_summaries s ON s.id = session_summaries_fts.rowid
  JOIN sessions ss ON ss.session_id = s.session_id
  WHERE session_summaries_fts MATCH ?
  ORDER BY s.created_at DESC
  LIMIT 10
\`).all(query);

if (summaries.length > 0) {
  console.log('## Session Summaries\\n');
  for (const s of summaries) {
    const date = new Date(s.created_at * 1000).toLocaleString();
    console.log(\`**\${date}** (\${s.project})\\n\${s.summary}\\nFiles: \${[s.files_read, s.files_edited].filter(Boolean).join(', ')}\\n\`);
  }
}

// Search observations
const observations = db.query(\`
  SELECT o.tool_name, o.files_touched, o.created_at,
         snippet(observations_fts, 1, '**', '**', '...', 32) as context
  FROM observations_fts
  JOIN observations o ON o.id = observations_fts.rowid
  WHERE observations_fts MATCH ?
  ORDER BY o.created_at DESC
  LIMIT 10
\`).all(query);

if (observations.length > 0) {
  console.log('## Observations\\n');
  for (const o of observations) {
    const date = new Date(o.created_at * 1000).toLocaleString();
    console.log(\`**\${date}** [\${o.tool_name}] \${o.files_touched || ''} — \${o.context}\\n\`);
  }
}

if (summaries.length === 0 && observations.length === 0) {
  console.log('No results found for: ' + query);
}

db.close();
"
```

Replace `$ARGUMENTS` with the user's search query.

## Tips

- Search uses FTS5 full-text search — keywords work best
- Results span all projects unless filtered
- Summaries provide high-level context, observations show individual tool calls
