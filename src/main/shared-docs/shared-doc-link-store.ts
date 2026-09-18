import type { SharedDocKind, SharedDocPermission } from '../../shared/shared-docs/types';
import { getDatabase } from '../db/database';

export interface SharedDocLinkRow {
  doc_id: string;
  local_path: string;
  s3_key: string;
  version: number;
  permission: string;
  session_id: string;
  title: string;
  kind: string;
  updated_at: number;
}

let schemaReady = false;

function ensureSchema(): void {
  if (schemaReady) return;
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_doc_links (
      doc_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      local_path TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      permission TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (doc_id, session_id)
    );
  `);
  schemaReady = true;
}

export function upsertSharedDocLink(row: {
  docId: string;
  sessionId: string;
  localPath: string;
  s3Key: string;
  version: number;
  permission: SharedDocPermission | 'owner';
  title: string;
  kind: SharedDocKind;
}): void {
  ensureSchema();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `INSERT INTO shared_doc_links (
      doc_id, session_id, local_path, s3_key, version, permission, title, kind, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id, session_id) DO UPDATE SET
      local_path = excluded.local_path,
      s3_key = excluded.s3_key,
      version = excluded.version,
      permission = excluded.permission,
      title = excluded.title,
      kind = excluded.kind,
      updated_at = excluded.updated_at`
  ).run(
    row.docId,
    row.sessionId,
    row.localPath,
    row.s3Key,
    row.version,
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

export function listSharedDocLinksForSession(sessionId: string): SharedDocLinkRow[] {
  ensureSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM shared_doc_links WHERE session_id = ? ORDER BY updated_at DESC')
    .all(sessionId) as SharedDocLinkRow[];
}
