/**
 * Brainstorm tables. Kept separate so tests can apply the schema on :memory: SQLite
 * without booting Electron.
 */

function ensureColumn(
  database: {
    exec: (sql: string) => void;
    prepare?: (sql: string) => { all: () => Array<{ name: string }> };
  },
  table: string,
  column: string,
  definition: string
): void {
  if (typeof database.prepare !== 'function') {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    } catch {
      /* already present, or the driver has no prepare (tests still get CREATE) */
    }
    return;
  }
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function ensureBrainstormSchema(database: {
  exec: (sql: string) => void;
  prepare?: (sql: string) => { all: () => Array<{ name: string }> };
}): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS brainstorms (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      goal TEXT,
      technique TEXT NOT NULL DEFAULT 'auto',
      profile_snapshot TEXT NOT NULL DEFAULT '{}',
      signals TEXT NOT NULL DEFAULT '[]',
      phase TEXT NOT NULL DEFAULT 'frame',
      status TEXT NOT NULL DEFAULT 'active',
      brief TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brainstorm_ideas (
      id TEXT PRIMARY KEY,
      brainstorm_id TEXT NOT NULL,
      cluster TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      rationale TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      impact INTEGER,
      effort INTEGER,
      starred INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      sources TEXT NOT NULL DEFAULT '[]',
      author TEXT NOT NULL DEFAULT 'agent',
      author_email TEXT,
      author_name TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (brainstorm_id) REFERENCES brainstorms(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_brainstorm_ideas_board
    ON brainstorm_ideas(brainstorm_id, position, created_at);

    CREATE TABLE IF NOT EXISTS brainstorm_activity (
      id TEXT PRIMARY KEY,
      brainstorm_id TEXT NOT NULL,
      idea_id TEXT,
      actor_email TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      text TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_brainstorm_activity_time
    ON brainstorm_activity(brainstorm_id, created_at);
  `);
  ensureColumn(database, 'brainstorms', 'room_id', 'room_id TEXT');
  ensureColumn(database, 'brainstorms', 'role', 'role TEXT');
  ensureColumn(database, 'brainstorm_ideas', 'author_email', 'author_email TEXT');
  ensureColumn(database, 'brainstorm_ideas', 'author_name', 'author_name TEXT');
}
