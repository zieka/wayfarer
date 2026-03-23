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
