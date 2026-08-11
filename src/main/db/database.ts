/**
 * SQLite database implementation using better-sqlite3
 * Provides persistent storage for sessions, messages, and other data
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync } from 'fs';
import { log, logError, logWarn } from '../utils/logger';

export interface DatabaseInstance {
  // Raw database access (for advanced queries)
  raw: Database.Database;

  // Session operations
  sessions: {
    create: (session: SessionRow) => void;
    update: (id: string, updates: Partial<SessionRow>) => void;
    get: (id: string) => SessionRow | undefined;
    getAll: () => SessionRow[];
    delete: (id: string) => void;
  };

  folders: {
    create: (folder: FolderRow) => void;
    update: (id: string, updates: Partial<FolderRow>) => void;
    get: (id: string) => FolderRow | undefined;
    list: () => FolderRow[];
    delete: (id: string) => void;
  };

  // Message operations
  messages: {
    create: (message: MessageRow) => void;
    update: (id: string, updates: Partial<Pick<MessageRow, 'execution_time_ms'>>) => void;
    getBySessionId: (sessionId: string) => MessageRow[];
    delete: (id: string) => void;
    deleteBySessionId: (sessionId: string) => void;
  };

  traceSteps: {
    create: (step: TraceStepRow) => void;
    update: (id: string, updates: Partial<TraceStepRow>) => void;
    getBySessionId: (sessionId: string) => TraceStepRow[];
    deleteBySessionId: (sessionId: string) => void;
  };

  scheduledTasks: {
    create: (task: ScheduledTaskRow) => void;
    update: (id: string, updates: Partial<ScheduledTaskRow>) => void;
    get: (id: string) => ScheduledTaskRow | undefined;
    getAll: () => ScheduledTaskRow[];
    delete: (id: string) => void;
  };

  matterItems: {
    create: (item: MatterItemRow) => void;
    update: (id: string, updates: Partial<MatterItemRow>) => void;
    get: (id: string) => MatterItemRow | undefined;
    getByFingerprint: (fingerprint: string) => MatterItemRow | undefined;
    listActive: () => MatterItemRow[];
    listAll: (limit?: number) => MatterItemRow[];
    delete: (id: string) => void;
  };

  matterActions: {
    create: (action: MatterActionRow) => void;
    listMuteRules: () => MatterActionRow[];
    listRecent: (limit?: number) => MatterActionRow[];
  };

  matterScans: {
    create: (scan: MatterScanRow) => void;
    update: (id: string, updates: Partial<MatterScanRow>) => void;
    get: (id: string) => MatterScanRow | undefined;
    getLatest: () => MatterScanRow | undefined;
    list: (limit?: number) => MatterScanRow[];
  };

  // For compatibility with old interface
  prepare: (sql: string) => Database.Statement;
  exec: (sql: string) => void;
  pragma: (pragma: string) => unknown;
  close: () => void;
}

export interface SessionRow {
  id: string;
  title: string;
  claude_session_id: string | null;
  openai_thread_id: string | null;
  status: string;
  cwd: string | null;
  mounted_paths: string; // JSON string
  allowed_tools: string; // JSON string
  memory_enabled: number;
  model: string | null;
  division: string;
  hub_project_id: string | null;
  hub_project_name: string | null;
  launchpad_project_id: number | null;
  launchpad_project_name: string | null;
  folder_id: string | null;
  folder_name: string | null;
  project_canonical_key: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface FolderRow {
  id: string;
  name: string;
  instructions: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string; // JSON string
  timestamp: number;
  token_usage: string | null; // JSON string
  execution_time_ms: number | null;
}

export interface TraceStepRow {
  id: string;
  session_id: string;
  type: string;
  status: string;
  title: string;
  content: string | null;
  tool_name: string | null;
  tool_input: string | null; // JSON string
  tool_output: string | null;
  is_error: number | null;
  timestamp: number;
  duration: number | null;
}

export interface ScheduledTaskRow {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  run_at: number;
  next_run_at: number | null;
  schedule_config: string | null;
  repeat_every: number | null;
  repeat_unit: string | null;
  enabled: number;
  last_run_at: number | null;
  last_run_session_id: string | null;
  last_error: string | null;
  model: string | null;
  provider: string | null;
  kind: string | null;
  session_mode: string | null;
  bound_session_id: string | null;
  watch_config: string | null;
  last_state: string | null;
  last_checked_at: number | null;
  consecutive_unchanged: number | null;
  /** Workspace division (general / hub / project / folder). */
  division: string | null;
  hub_project_id: string | null;
  hub_project_name: string | null;
  launchpad_project_id: number | null;
  launchpad_project_name: string | null;
  folder_id: string | null;
  folder_name: string | null;
  project_canonical_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface MatterItemRow {
  id: string;
  fingerprint: string;
  title: string;
  summary: string;
  why_it_matters: string;
  raw_details: string | null;
  severity: string;
  orbit: string;
  category: string;
  source: string;
  source_ref: string;
  confidence: number;
  suggested_action: string | null;
  status: string;
  pinned: number;
  snooze_until: number | null;
  due_at: number | null;
  remind_at: number | null;
  expires_at: number | null;
  reminder_notified_at: number | null;
  expired_notified_at: number | null;
  rank_score: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  resolved_at: number | null;
}

export interface MatterActionRow {
  id: string;
  item_id: string | null;
  fingerprint: string | null;
  action: string;
  mute_key: string | null;
  meta: string | null;
  created_at: number;
}

export interface MatterScanRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  status: string;
  sources_checked: string;
  sources_skipped: string;
  item_count: number;
  critical_count: number;
  warning_count: number;
  error: string | null;
  brief: string | null;
}

let db: DatabaseInstance | null = null;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

function buildBackupPath(targetPath: string, suffix: string): string {
  return `${targetPath}.${suffix}-${Date.now()}`;
}

function moveIfExists(sourcePath: string, destinationPath: string): void {
  if (!existsSync(sourcePath)) {
    return;
  }
  renameSync(sourcePath, destinationPath);
}

function ensureDirectory(pathToEnsure: string, label: string): void {
  if (!existsSync(pathToEnsure)) {
    mkdirSync(pathToEnsure, { recursive: true });
    return;
  }

  const stats = statSync(pathToEnsure);
  if (stats.isDirectory()) {
    return;
  }

  const backupPath = buildBackupPath(pathToEnsure, 'backup');
  renameSync(pathToEnsure, backupPath);
  logWarn(`[Database] ${label} path is not a directory, moved to backup:`, backupPath);
  mkdirSync(pathToEnsure, { recursive: true });
}

function isSqliteFile(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(fd, buffer, 0, SQLITE_HEADER.length, 0);
    if (bytesRead < SQLITE_HEADER.length) {
      return false;
    }
    return buffer.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function prepareDatabaseDirectory(userDataPath: string): string {
  ensureDirectory(userDataPath, 'userData');

  const dbDir = join(userDataPath, 'data');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    return dbDir;
  }

  const stats = statSync(dbDir);
  if (stats.isDirectory()) {
    return dbDir;
  }

  const preservedPath = buildBackupPath(dbDir, isSqliteFile(dbDir) ? 'legacy-db' : 'conflict');
  renameSync(dbDir, preservedPath);
  mkdirSync(dbDir, { recursive: true });

  if (isSqliteFile(preservedPath)) {
    const recoveredDbPath = join(dbDir, 'york-ie.db');
    renameSync(preservedPath, recoveredDbPath);
    moveIfExists(`${dbDir}-wal`, `${recoveredDbPath}-wal`);
    moveIfExists(`${dbDir}-shm`, `${recoveredDbPath}-shm`);
    logWarn('[Database] Recovered legacy SQLite file into:', recoveredDbPath);
  } else {
    logWarn(
      '[Database] Database directory path was occupied by a file, moved to backup:',
      preservedPath
    );
  }

  return dbDir;
}

/**
 * Get the database file path
 */
function getDatabasePath(): string {
  // Use electron's userData path for persistent storage
  const userDataPath = app.getPath('userData');
  const dbDir = prepareDatabaseDirectory(userDataPath);
  const dbPath = join(dbDir, 'york-ie.db');

  if (existsSync(dbPath) && statSync(dbPath).isDirectory()) {
    const backupPath = buildBackupPath(dbPath, 'dir-backup');
    renameSync(dbPath, backupPath);
    logWarn('[Database] Database file path is a directory, moved to backup:', backupPath);
  }

  return dbPath;
}

/**
 * Initialize the database schema
 */
function initializeSchema(database: Database.Database): void {
  try {
    // Enable WAL mode for better performance
    database.pragma('journal_mode = WAL');

    // Create sessions table
    database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      openai_thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      cwd TEXT,
      mounted_paths TEXT NOT NULL DEFAULT '[]',
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      memory_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

    ensureColumn(database, 'sessions', 'openai_thread_id', 'openai_thread_id TEXT');
    ensureColumn(database, 'sessions', 'model', 'model TEXT');
    ensureColumn(database, 'sessions', 'division', "division TEXT NOT NULL DEFAULT 'general'");
    ensureColumn(database, 'sessions', 'hub_project_id', 'hub_project_id TEXT');
    ensureColumn(database, 'sessions', 'hub_project_name', 'hub_project_name TEXT');
    ensureColumn(database, 'sessions', 'launchpad_project_id', 'launchpad_project_id INTEGER');
    ensureColumn(database, 'sessions', 'launchpad_project_name', 'launchpad_project_name TEXT');
    ensureColumn(database, 'sessions', 'folder_id', 'folder_id TEXT');
    ensureColumn(database, 'sessions', 'folder_name', 'folder_name TEXT');
    ensureColumn(database, 'sessions', 'project_canonical_key', 'project_canonical_key TEXT');
    ensureColumn(database, 'sessions', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');

    database.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      instructions TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

    // Backfill null division for rows created before the column existed
    database.exec(
      `UPDATE sessions SET division = 'general' WHERE division IS NULL OR division = ''`
    );

    // Create messages table
    database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      token_usage TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

    ensureColumn(database, 'messages', 'execution_time_ms', 'execution_time_ms INTEGER');

    // Create trace steps table
    database.exec(`
    CREATE TABLE IF NOT EXISTS trace_steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      is_error INTEGER,
      timestamp INTEGER NOT NULL,
      duration INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

    // Create index for faster message queries
    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_id 
    ON messages(session_id)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
    ON messages(session_id, timestamp)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_trace_steps_session_id
    ON trace_steps(session_id)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_trace_steps_timestamp
    ON trace_steps(session_id, timestamp)
  `);

    // Create memory_entries table (for future use)
    database.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

    // Create skills table (for future use)
    database.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT,
      created_at INTEGER NOT NULL
    )
  `);

    database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      next_run_at INTEGER,
      schedule_config TEXT,
      repeat_every INTEGER,
      repeat_unit TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      last_run_session_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
    ensureColumn(database, 'scheduled_tasks', 'schedule_config', 'schedule_config TEXT');
    ensureColumn(database, 'scheduled_tasks', 'model', 'model TEXT');
    ensureColumn(database, 'scheduled_tasks', 'provider', 'provider TEXT');
    ensureColumn(database, 'scheduled_tasks', 'kind', 'kind TEXT');
    ensureColumn(database, 'scheduled_tasks', 'session_mode', 'session_mode TEXT');
    ensureColumn(database, 'scheduled_tasks', 'bound_session_id', 'bound_session_id TEXT');
    ensureColumn(database, 'scheduled_tasks', 'watch_config', 'watch_config TEXT');
    ensureColumn(database, 'scheduled_tasks', 'last_state', 'last_state TEXT');
    ensureColumn(database, 'scheduled_tasks', 'last_checked_at', 'last_checked_at INTEGER');
    ensureColumn(
      database,
      'scheduled_tasks',
      'consecutive_unchanged',
      'consecutive_unchanged INTEGER'
    );
    ensureColumn(database, 'scheduled_tasks', 'division', "division TEXT NOT NULL DEFAULT 'general'");
    ensureColumn(database, 'scheduled_tasks', 'hub_project_id', 'hub_project_id TEXT');
    ensureColumn(database, 'scheduled_tasks', 'hub_project_name', 'hub_project_name TEXT');
    ensureColumn(
      database,
      'scheduled_tasks',
      'launchpad_project_id',
      'launchpad_project_id INTEGER'
    );
    ensureColumn(
      database,
      'scheduled_tasks',
      'launchpad_project_name',
      'launchpad_project_name TEXT'
    );
    ensureColumn(database, 'scheduled_tasks', 'folder_id', 'folder_id TEXT');
    ensureColumn(database, 'scheduled_tasks', 'folder_name', 'folder_name TEXT');
    ensureColumn(
      database,
      'scheduled_tasks',
      'project_canonical_key',
      'project_canonical_key TEXT'
    );
    database.exec(
      `UPDATE scheduled_tasks SET division = 'general' WHERE division IS NULL OR division = ''`
    );

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
    ON scheduled_tasks(enabled, next_run_at)
  `);

    database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'manager',
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

    database.exec(`
    CREATE TABLE IF NOT EXISTS matter_items (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      why_it_matters TEXT NOT NULL DEFAULT '',
      raw_details TEXT,
      severity TEXT NOT NULL DEFAULT 'signal',
      orbit TEXT NOT NULL DEFAULT 'watching',
      category TEXT NOT NULL DEFAULT 'comms',
      source TEXT NOT NULL DEFAULT 'hub',
      source_ref TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0.5,
      suggested_action TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      snooze_until INTEGER,
      expires_at INTEGER,
      rank_score REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      resolved_at INTEGER
    )
  `);
    ensureColumn(database, 'matter_items', 'raw_details', 'raw_details TEXT');
    ensureColumn(database, 'matter_items', 'due_at', 'due_at INTEGER');
    ensureColumn(database, 'matter_items', 'remind_at', 'remind_at INTEGER');
    ensureColumn(database, 'matter_items', 'reminder_notified_at', 'reminder_notified_at INTEGER');
    ensureColumn(database, 'matter_items', 'expired_notified_at', 'expired_notified_at INTEGER');

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_matter_items_status_rank
    ON matter_items(status, rank_score DESC)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_matter_items_fingerprint
    ON matter_items(fingerprint)
  `);

    database.exec(`
    CREATE TABLE IF NOT EXISTS matter_actions (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      fingerprint TEXT,
      action TEXT NOT NULL,
      mute_key TEXT,
      meta TEXT,
      created_at INTEGER NOT NULL
    )
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_matter_actions_mute
    ON matter_actions(action, mute_key)
  `);

    database.exec(`
    CREATE TABLE IF NOT EXISTS matter_scans (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      sources_checked TEXT NOT NULL DEFAULT '[]',
      sources_skipped TEXT NOT NULL DEFAULT '[]',
      item_count INTEGER NOT NULL DEFAULT 0,
      critical_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      brief TEXT
    )
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_matter_scans_started
    ON matter_scans(started_at DESC)
  `);

    // Memory Wiki pages (M1) — SQLite primary; Markdown vault is mirrored on disk
    database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      score REAL NOT NULL DEFAULT 0,
      sources TEXT NOT NULL DEFAULT '[]',
      division_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_wiki_pages_path
    ON wiki_pages(path)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_wiki_pages_score
    ON wiki_pages(score DESC, updated_at DESC)
  `);

    // Summary Tree nodes (OpenHuman-aligned L0→L1→L2 over wiki leaves)
    database.exec(`
    CREATE TABLE IF NOT EXISTS summary_tree_nodes (
      id TEXT PRIMARY KEY,
      tree_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      level INTEGER NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      wiki_page_id TEXT,
      score REAL NOT NULL DEFAULT 0,
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_summary_tree_nodes_tree
    ON summary_tree_nodes(tree_key)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_summary_tree_nodes_parent
    ON summary_tree_nodes(parent_id)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_summary_tree_nodes_kind
    ON summary_tree_nodes(kind)
  `);

    // Durable orchestration checkpoints (M3)
    database.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      step_id TEXT NOT NULL DEFAULT 'start',
      status TEXT NOT NULL DEFAULT 'running',
      payload TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      cost_usd REAL,
      session_id TEXT,
      source_id TEXT,
      title TEXT,
      stuck_summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_checkpoint_runs_status
    ON checkpoint_runs(status, updated_at)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_checkpoint_runs_session
    ON checkpoint_runs(session_id)
  `);

    // Visual workflows (M4) — versioned graph JSON
    database.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      graph_json TEXT NOT NULL,
      schedule_task_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

    ensureColumn(database, 'workflows', 'division', "division TEXT NOT NULL DEFAULT 'general'");
    ensureColumn(database, 'workflows', 'hub_project_id', 'hub_project_id TEXT');
    ensureColumn(database, 'workflows', 'hub_project_name', 'hub_project_name TEXT');
    ensureColumn(database, 'workflows', 'launchpad_project_id', 'launchpad_project_id INTEGER');
    ensureColumn(database, 'workflows', 'launchpad_project_name', 'launchpad_project_name TEXT');
    ensureColumn(database, 'workflows', 'folder_id', 'folder_id TEXT');
    ensureColumn(database, 'workflows', 'folder_name', 'folder_name TEXT');
    ensureColumn(database, 'workflows', 'project_canonical_key', 'project_canonical_key TEXT');

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflows_status
    ON workflows(status, updated_at DESC)
  `);

    log('[Database] Schema initialized');
  } catch (error) {
    logError('[Database] Schema initialization failed:', error);
    throw error;
  }
}

function validateIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}

const ALLOWED_COLUMN_TYPES = [
  'TEXT NOT NULL DEFAULT',
  'INTEGER DEFAULT',
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
] as const;

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  validateIdentifier(table);
  validateIdentifier(column);

  // Reconstruct definition from validated parts to prevent SQL injection.
  // The definition format is: "<column> <TYPE_SUFFIX>" — extract the type
  // suffix that follows the column name and validate it against an allowlist.
  const prefix = column + ' ';
  if (!definition.startsWith(prefix)) {
    throw new Error(`Column definition must start with column name: ${definition}`);
  }
  const typeSuffix = definition.slice(prefix.length).trim().toUpperCase();
  const matchedType = ALLOWED_COLUMN_TYPES.find(
    (t) => typeSuffix === t || typeSuffix.startsWith(t + ' ')
  );
  if (!matchedType) {
    throw new Error(`Unsupported column type in definition: ${typeSuffix}`);
  }
  // Use only the validated column name + original (non-uppercased) suffix so
  // that default value tokens are preserved exactly as authored.
  const originalSuffix = definition.slice(prefix.length).trim();
  const safeDefinition = `${column} ${originalSuffix}`;

  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = rows.some((row) => row.name === column);
  if (exists) {
    return;
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${safeDefinition}`);
}

/**
 * Initialize the database
 */
export function initDatabase(): DatabaseInstance {
  if (db) return db;

  const dbPath = getDatabasePath();
  log('[Database] Opening database at:', dbPath);

  let rawDb: Database.Database;
  try {
    rawDb = new Database(dbPath);
  } catch (error) {
    logError('[Database] Failed to open database at:', dbPath, error);
    throw error;
  }

  // Enable foreign keys
  rawDb.pragma('foreign_keys = ON');

  // Initialize schema
  initializeSchema(rawDb);

  // Prepare statements for better performance
  const insertSession = rawDb.prepare(`
    INSERT OR REPLACE INTO sessions
    (id, title, claude_session_id, openai_thread_id, status, cwd, mounted_paths, allowed_tools, memory_enabled, model, division, hub_project_id, hub_project_name, launchpad_project_id, launchpad_project_name, folder_id, folder_name, project_canonical_key, pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Note: Dynamic update queries are built in sessions.update() for flexibility
  // const updateSessionStmt = rawDb.prepare(`
  //   UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?
  // `);

  const getSessionStmt = rawDb.prepare(`
    SELECT * FROM sessions WHERE id = ?
  `);

  const getAllSessionsStmt = rawDb.prepare(`
    SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC
  `);

  const deleteSessionStmt = rawDb.prepare(`
    DELETE FROM sessions WHERE id = ?
  `);

  const insertMessage = rawDb.prepare(`
    INSERT INTO messages (id, session_id, role, content, timestamp, token_usage, execution_time_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const getMessagesBySessionStmt = rawDb.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
  `);

  const updateMessageStmt = rawDb.prepare(`
    UPDATE messages SET execution_time_ms = ? WHERE id = ?
  `);

  const deleteMessageStmt = rawDb.prepare(`
    DELETE FROM messages WHERE id = ?
  `);

  const deleteMessagesBySessionStmt = rawDb.prepare(`
    DELETE FROM messages WHERE session_id = ?
  `);

  const insertTraceStep = rawDb.prepare(`
    INSERT OR REPLACE INTO trace_steps (
      id, session_id, type, status, title, content, tool_name, tool_input, tool_output, is_error, timestamp, duration
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getTraceStepsBySessionStmt = rawDb.prepare(`
    SELECT * FROM trace_steps WHERE session_id = ? ORDER BY timestamp ASC
  `);

  const deleteTraceStepsBySessionStmt = rawDb.prepare(`
    DELETE FROM trace_steps WHERE session_id = ?
  `);

  const insertScheduledTask = rawDb.prepare(`
    INSERT OR REPLACE INTO scheduled_tasks (
      id, title, prompt, cwd, run_at, next_run_at, schedule_config, repeat_every, repeat_unit, enabled, last_run_at, last_run_session_id, last_error, model, provider, kind, session_mode, bound_session_id, watch_config, last_state, last_checked_at, consecutive_unchanged,
      division, hub_project_id, hub_project_name, launchpad_project_id, launchpad_project_name, folder_id, folder_name, project_canonical_key,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getScheduledTaskStmt = rawDb.prepare(`
    SELECT * FROM scheduled_tasks WHERE id = ?
  `);

  const getAllScheduledTasksStmt = rawDb.prepare(`
    SELECT * FROM scheduled_tasks ORDER BY created_at ASC
  `);

  const deleteScheduledTaskStmt = rawDb.prepare(`
    DELETE FROM scheduled_tasks WHERE id = ?
  `);

  const insertMatterItem = rawDb.prepare(`
    INSERT OR REPLACE INTO matter_items (
      id, fingerprint, title, summary, why_it_matters, raw_details, severity, orbit, category, source,
      source_ref, confidence, suggested_action, status, pinned, snooze_until, due_at, remind_at,
      expires_at, reminder_notified_at, expired_notified_at,
      rank_score, created_at, updated_at, last_seen_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getMatterItemStmt = rawDb.prepare(`SELECT * FROM matter_items WHERE id = ?`);
  const getMatterItemByFingerprintStmt = rawDb.prepare(
    `SELECT * FROM matter_items WHERE fingerprint = ?`
  );
  const listActiveMatterItemsStmt = rawDb.prepare(`
    SELECT * FROM matter_items
    WHERE status IN ('active', 'snoozed', 'resurfaced')
    ORDER BY pinned DESC, rank_score DESC, updated_at DESC
  `);
  const listAllMatterItemsStmt = rawDb.prepare(`
    SELECT * FROM matter_items ORDER BY updated_at DESC LIMIT ?
  `);
  const deleteMatterItemStmt = rawDb.prepare(`DELETE FROM matter_items WHERE id = ?`);

  const insertMatterAction = rawDb.prepare(`
    INSERT INTO matter_actions (id, item_id, fingerprint, action, mute_key, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listMuteMatterActionsStmt = rawDb.prepare(`
    SELECT * FROM matter_actions WHERE action = 'mute' AND mute_key IS NOT NULL
    ORDER BY created_at DESC
  `);
  const listRecentMatterActionsStmt = rawDb.prepare(`
    SELECT * FROM matter_actions ORDER BY created_at DESC LIMIT ?
  `);

  const insertMatterScan = rawDb.prepare(`
    INSERT INTO matter_scans (
      id, started_at, finished_at, duration_ms, status, sources_checked, sources_skipped,
      item_count, critical_count, warning_count, error, brief
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getMatterScanStmt = rawDb.prepare(`SELECT * FROM matter_scans WHERE id = ?`);
  const getLatestMatterScanStmt = rawDb.prepare(`
    SELECT * FROM matter_scans ORDER BY started_at DESC LIMIT 1
  `);
  const listMatterScansStmt = rawDb.prepare(`
    SELECT * FROM matter_scans ORDER BY started_at DESC LIMIT ?
  `);

  const insertFolder = rawDb.prepare(`
    INSERT OR REPLACE INTO folders (id, name, instructions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getFolderStmt = rawDb.prepare(`SELECT * FROM folders WHERE id = ?`);
  const listFoldersStmt = rawDb.prepare(`SELECT * FROM folders ORDER BY updated_at DESC`);
  const deleteFolderStmt = rawDb.prepare(`DELETE FROM folders WHERE id = ?`);

  db = {
    raw: rawDb,

    sessions: {
      create: (session: SessionRow) => {
        insertSession.run(
          session.id,
          session.title,
          session.claude_session_id,
          session.openai_thread_id,
          session.status,
          session.cwd,
          session.mounted_paths,
          session.allowed_tools,
          session.memory_enabled,
          session.model,
          session.division || 'general',
          session.hub_project_id ?? null,
          session.hub_project_name ?? null,
          session.launchpad_project_id ?? null,
          session.launchpad_project_name ?? null,
          session.folder_id ?? null,
          session.folder_name ?? null,
          session.project_canonical_key ?? null,
          session.pinned ?? 0,
          session.created_at,
          session.updated_at
        );
      },

      update: (id: string, updates: Partial<SessionRow>) => {
        // Columns that must never be overwritten after insert
        const IMMUTABLE_COLUMNS = new Set(['id', 'created_at']);

        // Build dynamic update query
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            if (IMMUTABLE_COLUMNS.has(key)) continue;
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }

        if (setClauses.length === 0) return;

        // Always update updated_at
        setClauses.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);

        const sql = `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`;
        rawDb.prepare(sql).run(...values);
      },

      get: (id: string): SessionRow | undefined => {
        return getSessionStmt.get(id) as SessionRow | undefined;
      },

      getAll: (): SessionRow[] => {
        return getAllSessionsStmt.all() as SessionRow[];
      },

      delete: (id: string) => {
        // Messages will be deleted automatically due to ON DELETE CASCADE
        deleteSessionStmt.run(id);
      },
    },

    folders: {
      create: (folder: FolderRow) => {
        insertFolder.run(
          folder.id,
          folder.name,
          folder.instructions ?? null,
          folder.created_at,
          folder.updated_at
        );
      },
      update: (id: string, updates: Partial<FolderRow>) => {
        const setClauses: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined && key !== 'id') {
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }
        if (setClauses.length === 0) return;
        values.push(id);
        rawDb.prepare(`UPDATE folders SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
      },
      get: (id: string): FolderRow | undefined => {
        return getFolderStmt.get(id) as FolderRow | undefined;
      },
      list: (): FolderRow[] => {
        return listFoldersStmt.all() as FolderRow[];
      },
      delete: (id: string) => {
        deleteFolderStmt.run(id);
      },
    },

    messages: {
      create: (message: MessageRow) => {
        insertMessage.run(
          message.id,
          message.session_id,
          message.role,
          message.content,
          message.timestamp,
          message.token_usage,
          message.execution_time_ms ?? null
        );
      },

      update: (id: string, updates: Partial<Pick<MessageRow, 'execution_time_ms'>>) => {
        if (updates.execution_time_ms !== undefined) {
          updateMessageStmt.run(updates.execution_time_ms, id);
        }
      },

      getBySessionId: (sessionId: string): MessageRow[] => {
        return getMessagesBySessionStmt.all(sessionId) as MessageRow[];
      },

      delete: (id: string) => {
        deleteMessageStmt.run(id);
      },

      deleteBySessionId: (sessionId: string) => {
        deleteMessagesBySessionStmt.run(sessionId);
      },
    },

    traceSteps: {
      create: (step: TraceStepRow) => {
        insertTraceStep.run(
          step.id,
          step.session_id,
          step.type,
          step.status,
          step.title,
          step.content,
          step.tool_name,
          step.tool_input,
          step.tool_output,
          step.is_error,
          step.timestamp,
          step.duration
        );
      },

      update: (id: string, updates: Partial<TraceStepRow>) => {
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }

        if (setClauses.length === 0) return;

        values.push(id);
        const sql = `UPDATE trace_steps SET ${setClauses.join(', ')} WHERE id = ?`;
        rawDb.prepare(sql).run(...values);
      },

      getBySessionId: (sessionId: string): TraceStepRow[] => {
        return getTraceStepsBySessionStmt.all(sessionId) as TraceStepRow[];
      },

      deleteBySessionId: (sessionId: string) => {
        deleteTraceStepsBySessionStmt.run(sessionId);
      },
    },

    scheduledTasks: {
      create: (task: ScheduledTaskRow) => {
        insertScheduledTask.run(
          task.id,
          task.title,
          task.prompt,
          task.cwd,
          task.run_at,
          task.next_run_at,
          task.schedule_config,
          task.repeat_every,
          task.repeat_unit,
          task.enabled,
          task.last_run_at,
          task.last_run_session_id,
          task.last_error,
          task.model,
          task.provider,
          task.kind,
          task.session_mode,
          task.bound_session_id,
          task.watch_config,
          task.last_state,
          task.last_checked_at,
          task.consecutive_unchanged,
          task.division ?? 'general',
          task.hub_project_id ?? null,
          task.hub_project_name ?? null,
          task.launchpad_project_id ?? null,
          task.launchpad_project_name ?? null,
          task.folder_id ?? null,
          task.folder_name ?? null,
          task.project_canonical_key ?? null,
          task.created_at,
          task.updated_at
        );
      },

      update: (id: string, updates: Partial<ScheduledTaskRow>) => {
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }

        if (setClauses.length === 0) return;

        setClauses.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);

        const sql = `UPDATE scheduled_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        rawDb.prepare(sql).run(...values);
      },

      get: (id: string): ScheduledTaskRow | undefined => {
        return getScheduledTaskStmt.get(id) as ScheduledTaskRow | undefined;
      },

      getAll: (): ScheduledTaskRow[] => {
        return getAllScheduledTasksStmt.all() as ScheduledTaskRow[];
      },

      delete: (id: string) => {
        deleteScheduledTaskStmt.run(id);
      },
    },

    matterItems: {
      create: (item: MatterItemRow) => {
        insertMatterItem.run(
          item.id,
          item.fingerprint,
          item.title,
          item.summary,
          item.why_it_matters,
          item.raw_details,
          item.severity,
          item.orbit,
          item.category,
          item.source,
          item.source_ref,
          item.confidence,
          item.suggested_action,
          item.status,
          item.pinned,
          item.snooze_until,
          item.due_at ?? null,
          item.remind_at ?? null,
          item.expires_at,
          item.reminder_notified_at ?? null,
          item.expired_notified_at ?? null,
          item.rank_score,
          item.created_at,
          item.updated_at,
          item.last_seen_at,
          item.resolved_at
        );
      },

      update: (id: string, updates: Partial<MatterItemRow>) => {
        const setClauses: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }
        if (setClauses.length === 0) return;
        setClauses.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        rawDb
          .prepare(`UPDATE matter_items SET ${setClauses.join(', ')} WHERE id = ?`)
          .run(...values);
      },

      get: (id: string): MatterItemRow | undefined => {
        return getMatterItemStmt.get(id) as MatterItemRow | undefined;
      },

      getByFingerprint: (fingerprint: string): MatterItemRow | undefined => {
        return getMatterItemByFingerprintStmt.get(fingerprint) as MatterItemRow | undefined;
      },

      listActive: (): MatterItemRow[] => {
        return listActiveMatterItemsStmt.all() as MatterItemRow[];
      },

      listAll: (limit = 200): MatterItemRow[] => {
        return listAllMatterItemsStmt.all(limit) as MatterItemRow[];
      },

      delete: (id: string) => {
        deleteMatterItemStmt.run(id);
      },
    },

    matterActions: {
      create: (action: MatterActionRow) => {
        insertMatterAction.run(
          action.id,
          action.item_id,
          action.fingerprint,
          action.action,
          action.mute_key,
          action.meta,
          action.created_at
        );
      },

      listMuteRules: (): MatterActionRow[] => {
        return listMuteMatterActionsStmt.all() as MatterActionRow[];
      },

      listRecent: (limit = 100): MatterActionRow[] => {
        return listRecentMatterActionsStmt.all(limit) as MatterActionRow[];
      },
    },

    matterScans: {
      create: (scan: MatterScanRow) => {
        insertMatterScan.run(
          scan.id,
          scan.started_at,
          scan.finished_at,
          scan.duration_ms,
          scan.status,
          scan.sources_checked,
          scan.sources_skipped,
          scan.item_count,
          scan.critical_count,
          scan.warning_count,
          scan.error,
          scan.brief
        );
      },

      update: (id: string, updates: Partial<MatterScanRow>) => {
        const setClauses: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }
        if (setClauses.length === 0) return;
        values.push(id);
        rawDb
          .prepare(`UPDATE matter_scans SET ${setClauses.join(', ')} WHERE id = ?`)
          .run(...values);
      },

      get: (id: string): MatterScanRow | undefined => {
        return getMatterScanStmt.get(id) as MatterScanRow | undefined;
      },

      getLatest: (): MatterScanRow | undefined => {
        return getLatestMatterScanStmt.get() as MatterScanRow | undefined;
      },

      list: (limit = 20): MatterScanRow[] => {
        return listMatterScansStmt.all(limit) as MatterScanRow[];
      },
    },

    // Compatibility layer for old interface
    prepare: (sql: string) => rawDb.prepare(sql),
    exec: (sql: string) => rawDb.exec(sql),
    pragma: (pragma: string) => rawDb.pragma(pragma),
    close: () => {
      rawDb.close();
      db = null;
    },
  };

  log('[Database] SQLite database initialized successfully');
  return db!;
}

/**
 * Get the existing database instance
 */
export function getDatabase(): DatabaseInstance {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    log('[Database] Database closed');
  }
}
