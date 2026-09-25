import type { SharedDocKind, SharedDocPermission } from '../../shared/shared-docs/types';
import { getDatabase } from '../db/database';

export interface SharedDocLinkRow {
  doc_id: string;
  local_path: string;
  s3_key: string;
  s3_updated_at: string;
  permission: string;
  session_id: string;
  title: string;
  kind: string;
  updated_at: number;
}

let schemaReady = false;

function migrateLegacyVersionColumn(db: ReturnType<typeof getDatabase>): void {
  const cols = db.prepare('PRAGMA table_info(shared_doc_links)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('doc_id')) return;

  // Older builds used integer `version`; newer builds use `s3_updated_at`.
  // CREATE TABLE IF NOT EXISTS does not rewrite existing tables, so both columns can
  // coexist after a partial migration — and INSERT without `version` then fails
  // SQLITE_CONSTRAINT_NOTNULL.
  if (!names.has('s3_updated_at')) {
    db.exec(`ALTER TABLE shared_doc_links ADD COLUMN s3_updated_at TEXT NOT NULL DEFAULT ''`);
  }

  if (!names.has('version')) return;

  try {
    db.exec(`ALTER TABLE shared_doc_links DROP COLUMN version`);
  } catch {
    // SQLite < 3.35 has no DROP COLUMN — rebuild without the legacy column.
    db.exec(`
      CREATE TABLE shared_doc_links_migrated (
        doc_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        local_path TEXT NOT NULL,
        s3_key TEXT NOT NULL,
        s3_updated_at TEXT NOT NULL DEFAULT '',
        permission TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (doc_id, session_id)
      );
      INSERT INTO shared_doc_links_migrated (
        doc_id, session_id, local_path, s3_key, s3_updated_at, permission, title, kind, updated_at
      )
      SELECT
        doc_id, session_id, local_path, s3_key, s3_updated_at, permission, title, kind, updated_at
      FROM shared_doc_links;
      DROP TABLE shared_doc_links;
      ALTER TABLE shared_doc_links_migrated RENAME TO shared_doc_links;
    `);
  }
}

function ensureSchema(): void {
  if (schemaReady) return;
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_doc_links (
      doc_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      local_path TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      s3_updated_at TEXT NOT NULL DEFAULT '',
      permission TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (doc_id, session_id)
    );
  `);
  migrateLegacyVersionColumn(db);
  schemaReady = true;
}

export function upsertSharedDocLink(row: {
  docId: string;
  sessionId: string;
  localPath: string;
  s3Key: string;
  s3UpdatedAt: string;
  permission: SharedDocPermission | 'owner';
  title: string;
  kind: SharedDocKind;
}): void {
  ensureSchema();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `INSERT INTO shared_doc_links (
      doc_id, session_id, local_path, s3_key, s3_updated_at, permission, title, kind, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id, session_id) DO UPDATE SET
      local_path = excluded.local_path,
      s3_key = excluded.s3_key,
      s3_updated_at = excluded.s3_updated_at,
      permission = excluded.permission,
      title = excluded.title,
      kind = excluded.kind,
      updated_at = excluded.updated_at`
  ).run(
    row.docId,
    row.sessionId,
    row.localPath,
    row.s3Key,
    row.s3UpdatedAt,
    row.permission,
    row.title,
    row.kind,
    now
  );
}

export function getSharedDocLink(docId: string, sessionId: string): SharedDocLinkRow | undefined {
  ensureSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM shared_doc_links WHERE doc_id = ? AND session_id = ?')
    .get(docId, sessionId) as SharedDocLinkRow | undefined;
}

export function getSharedDocLinkByLocalPath(
  sessionId: string,
  localPath: string
): SharedDocLinkRow | undefined {
  ensureSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM shared_doc_links WHERE session_id = ? AND local_path = ?')
    .get(sessionId, localPath) as SharedDocLinkRow | undefined;
}

/** Newest link for a doc in any session (used to rehydrate a missing `shared/<id>/…` file). */
export function getLatestSharedDocLinkByDocId(docId: string): SharedDocLinkRow | undefined {
  ensureSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM shared_doc_links WHERE doc_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(docId) as SharedDocLinkRow | undefined;
}

export function listSharedDocLinksForSession(sessionId: string): SharedDocLinkRow[] {
  ensureSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM shared_doc_links WHERE session_id = ? ORDER BY updated_at DESC')
    .all(sessionId) as SharedDocLinkRow[];
}
