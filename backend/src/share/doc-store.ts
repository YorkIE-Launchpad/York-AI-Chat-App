import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  SharedDocAclEntry,
  SharedDocKind,
  SharedDocPermission,
  SharedDocRecord,
  SharedDocVersionEntry,
} from './types.js';

const MAX_VERSION_HISTORY = 20;

let dbSingleton: DatabaseSync | null = null;

function resolveDbPath(): string {
  const fromEnv = process.env.SHARE_DOCS_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  const dataDir = process.env.SHARE_DOCS_DATA_DIR?.trim() || join(process.cwd(), 'data');
  return join(dataDir, 'share-docs.sqlite');
}

export function getShareDocDb(dbPath?: string): DatabaseSync {
  if (dbSingleton && !dbPath) return dbSingleton;
  const path = dbPath ?? resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_docs (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acl_json TEXT NOT NULL DEFAULT '[]',
      versions_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_shared_docs_owner ON shared_docs(owner_sub);
  `);
  if (!dbPath) dbSingleton = db;
  return db;
}

/** @internal tests */
export function resetShareDocDbSingleton(): void {
  if (dbSingleton) {
    dbSingleton.close();
    dbSingleton = null;
  }
}

function rowToRecord(row: Record<string, unknown>): SharedDocRecord {
  return {
    id: String(row.id),
    ownerSub: String(row.owner_sub),
    ownerEmail: String(row.owner_email),
    title: String(row.title),
    kind: row.kind as SharedDocKind,
    s3Key: String(row.s3_key),
    version: Number(row.version),
    contentType: String(row.content_type),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    acl: JSON.parse(String(row.acl_json || '[]')) as SharedDocAclEntry[],
    versions: JSON.parse(String(row.versions_json || '[]')) as SharedDocVersionEntry[],
  };
}

export interface CreateDocInput {
  ownerSub: string;
  ownerEmail: string;
  title: string;
  kind: SharedDocKind;
  s3Key: string;
  contentType: string;
}

export function createSharedDoc(input: CreateDocInput, dbPath?: string): SharedDocRecord {
  const db = getShareDocDb(dbPath);
  const now = new Date().toISOString();
  const id = randomUUID();
  const version = 1;
  const versions: SharedDocVersionEntry[] = [
    {
      version: 1,
      s3Key: input.s3Key,
      updatedBy: input.ownerSub,
      updatedAt: now,
    },
  ];
  db.prepare(
    `INSERT INTO shared_docs (
      id, owner_sub, owner_email, title, kind, s3_key, version, content_type,
      created_at, updated_at, acl_json, versions_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
  ).run(
    id,
    input.ownerSub,
    input.ownerEmail.toLowerCase(),
    input.title.trim(),
    input.kind,
    input.s3Key,
    version,
    input.contentType,
    now,
    now,
    JSON.stringify(versions)
  );
  const row = db.prepare('SELECT * FROM shared_docs WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return rowToRecord(row);
}

export function getSharedDoc(id: string, dbPath?: string): SharedDocRecord | null {
  const db = getShareDocDb(dbPath);
  const row = db.prepare('SELECT * FROM shared_docs WHERE id = ?').get(id.trim()) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRecord(row) : null;
}

export function listSharedDocsForCaller(
  callerSub: string,
  callerEmail?: string,
  dbPath?: string
): SharedDocRecord[] {
  const db = getShareDocDb(dbPath);
  const rows = db.prepare('SELECT * FROM shared_docs ORDER BY updated_at DESC').all() as Array<
    Record<string, unknown>
  >;
  const email = callerEmail?.trim().toLowerCase();
  return rows
    .map(rowToRecord)
    .filter((doc) => {
      if (doc.ownerSub === callerSub) return true;
      return doc.acl.some((entry) => {
        const p = entry.principal.trim().toLowerCase();
        return p === callerSub.toLowerCase() || (email && p === email);
      });
    });
}

export function upsertAcl(
  docId: string,
  principal: string,
  permission: SharedDocPermission,
  dbPath?: string
): SharedDocRecord | null {
  const doc = getSharedDoc(docId, dbPath);
  if (!doc) return null;
  const normalized = principal.trim().toLowerCase();
  const acl = [...doc.acl.filter((e) => e.principal.trim().toLowerCase() !== normalized)];
  acl.push({ principal: normalized, permission });
  const now = new Date().toISOString();
  const db = getShareDocDb(dbPath);
  db.prepare('UPDATE shared_docs SET acl_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(acl),
    now,
    docId
  );
  return getSharedDoc(docId, dbPath);
}

export function removeAcl(
  docId: string,
  principal: string,
  dbPath?: string
): SharedDocRecord | null {
  const doc = getSharedDoc(docId, dbPath);
  if (!doc) return null;
  const normalized = principal.trim().toLowerCase();
  const acl = doc.acl.filter((e) => e.principal.trim().toLowerCase() !== normalized);
  const now = new Date().toISOString();
  const db = getShareDocDb(dbPath);
  db.prepare('UPDATE shared_docs SET acl_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(acl),
    now,
    docId
  );
  return getSharedDoc(docId, dbPath);
}

export function patchSharedDocVersion(
  docId: string,
  input: { s3Key: string; updatedBy: string; expectedVersion: number },
  dbPath?: string
): { ok: true; doc: SharedDocRecord } | { ok: false; error: 'not_found' | 'version_conflict' } {
  const doc = getSharedDoc(docId, dbPath);
  if (!doc) return { ok: false, error: 'not_found' };
  if (doc.version !== input.expectedVersion) {
    return { ok: false, error: 'version_conflict' };
  }
  const now = new Date().toISOString();
  const nextVersion = doc.version + 1;
  const versions = [
    ...doc.versions,
    {
      version: nextVersion,
      s3Key: input.s3Key,
      updatedBy: input.updatedBy,
      updatedAt: now,
    },
  ].slice(-MAX_VERSION_HISTORY);

  const db = getShareDocDb(dbPath);
  db.prepare(
    `UPDATE shared_docs SET s3_key = ?, version = ?, versions_json = ?, updated_at = ? WHERE id = ?`
  ).run(input.s3Key, nextVersion, JSON.stringify(versions), now, docId);

  const updated = getSharedDoc(docId, dbPath);
  if (!updated) return { ok: false, error: 'not_found' };
  return { ok: true, doc: updated };
}
