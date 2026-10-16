/**
 * SQLite-backed knowledge base: source metadata + full text + FTS5 chunk index.
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  KnowledgeScope,
  KnowledgeScopeRef,
  KnowledgeSearchHit,
  KnowledgeSource,
  KnowledgeSourceKind,
  KnowledgeSourceStatus,
} from '../../shared/knowledge-base';

/** Minimal surface shared by `DatabaseInstance` and a raw better-sqlite3 handle. */
export interface KnowledgeBaseDb {
  prepare: (sql: string) => Database.Statement;
  exec: (sql: string) => unknown;
}

interface KnowledgeSourceRow {
  id: string;
  scope: KnowledgeScope;
  scope_id: string;
  kind: KnowledgeSourceKind;
  title: string;
  origin_key: string;
  origin_path: string | null;
  url: string | null;
  mime_type: string | null;
  size_bytes: number;
  char_count: number;
  chunk_count: number;
  status: KnowledgeSourceStatus;
  error: string | null;
  meta: string | null;
  created_at: number;
  updated_at: number;
}

const SOURCE_COLUMNS = `id, scope, scope_id, kind, title, origin_key, origin_path, url, mime_type,
  size_bytes, char_count, chunk_count, status, error, meta, created_at, updated_at`;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'tell',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

export function ensureKnowledgeBaseSchema(db: KnowledgeBaseDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_sources (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      origin_key TEXT NOT NULL,
      origin_path TEXT,
      url TEXT,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'indexing',
      error TEXT,
      meta TEXT,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (scope, scope_id, origin_key)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_kb_sources_scope
    ON kb_sources(scope, scope_id, updated_at DESC)
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      source_id UNINDEXED,
      chunk_index UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
    )
  `);
}

/**
 * Natural-language question → FTS5 OR query. bm25 ranks chunks matching more
 * terms higher, so OR keeps recall without flooding results.
 */
export function toKnowledgeMatchQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  const unique = Array.from(new Set(tokens)).slice(0, 16);
  if (unique.length === 0) return '';
  return unique.map((token) => `"${token}"*`).join(' OR ');
}

function mapRow(row: KnowledgeSourceRow): KnowledgeSource {
  let meta: Record<string, string> | undefined;
  if (row.meta) {
    try {
      const parsed = JSON.parse(row.meta) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, string>;
      }
    } catch {
      meta = undefined;
    }
  }
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    kind: row.kind,
    title: row.title,
    originKey: row.origin_key,
    originPath: row.origin_path,
    url: row.url,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    charCount: row.char_count,
    chunkCount: row.chunk_count,
    status: row.status,
    error: row.error,
    meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertKnowledgeSourceInput extends KnowledgeScopeRef {
  kind: KnowledgeSourceKind;
  title: string;
  originKey: string;
  originPath?: string | null;
  url?: string | null;
  mimeType?: string | null;
  sizeBytes?: number;
  meta?: Record<string, string>;
}

export class KnowledgeBaseStore {
  constructor(private readonly db: KnowledgeBaseDb) {
    ensureKnowledgeBaseSchema(db);
  }

  /** Create or reset a source to `indexing`, keyed by (scope, scopeId, originKey). */
  upsertPending(input: UpsertKnowledgeSourceInput): KnowledgeSource {
    const now = Date.now();
    const existing = this.findByOrigin(input, input.originKey);
    const meta = input.meta ? JSON.stringify(input.meta) : null;
    if (existing) {
      this.db
        .prepare(
          `UPDATE kb_sources
           SET kind = ?, title = ?, origin_path = ?, url = ?, mime_type = ?, size_bytes = ?,
               status = 'indexing', error = NULL, meta = COALESCE(?, meta), updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.kind,
          input.title,
          input.originPath ?? existing.originPath ?? null,
          input.url ?? existing.url ?? null,
          input.mimeType ?? existing.mimeType ?? null,
          input.sizeBytes ?? existing.sizeBytes,
          meta,
          now,
          existing.id
        );
      return this.get(existing.id)!;
    }
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO kb_sources
         (id, scope, scope_id, kind, title, origin_key, origin_path, url, mime_type, size_bytes,
          status, meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, ?)`
      )
      .run(
        id,
        input.scope,
        input.scopeId,
        input.kind,
        input.title,
        input.originKey,
        input.originPath ?? null,
        input.url ?? null,
        input.mimeType ?? null,
        input.sizeBytes ?? 0,
        meta,
        now,
        now
      );
    return this.get(id)!;
  }

  /** Replace the stored text + chunk index and mark the source ready. */
  setContent(id: string, content: string, chunks: string[], title?: string): void {
    const source = this.get(id);
    if (!source) return;
    const finalTitle = title?.trim() || source.title;
    const insert = this.db.prepare(
      `INSERT INTO kb_chunks_fts (source_id, chunk_index, title, body) VALUES (?, ?, ?, ?)`
    );
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM kb_chunks_fts WHERE source_id = ?`).run(id);
      chunks.forEach((chunk, index) => insert.run(id, index, finalTitle, chunk));
      this.db
        .prepare(
          `UPDATE kb_sources
           SET content = ?, char_count = ?, chunk_count = ?, title = ?, status = 'ready',
               error = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(content, content.length, chunks.length, finalTitle, Date.now(), id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setError(id: string, message: string): void {
    this.db
      .prepare(`UPDATE kb_sources SET status = 'error', error = ?, updated_at = ? WHERE id = ?`)
      .run(message.slice(0, 500), Date.now(), id);
  }

  get(id: string): KnowledgeSource | null {
    const row = this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM kb_sources WHERE id = ?`).get(id) as
      | KnowledgeSourceRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  findByOrigin(ref: KnowledgeScopeRef, originKey: string): KnowledgeSource | null {
    const row = this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM kb_sources
         WHERE scope = ? AND scope_id = ? AND origin_key = ?`
      )
      .get(ref.scope, ref.scopeId, originKey) as KnowledgeSourceRow | undefined;
    return row ? mapRow(row) : null;
  }

  getContent(id: string): string | null {
    const row = this.db.prepare(`SELECT content FROM kb_sources WHERE id = ?`).get(id) as
      | { content: string }
      | undefined;
    return row ? row.content : null;
  }

  list(refs: KnowledgeScopeRef[]): KnowledgeSource[] {
    if (refs.length === 0) return [];
    const where = refs.map(() => '(scope = ? AND scope_id = ?)').join(' OR ');
    const params = refs.flatMap((ref) => [ref.scope, ref.scopeId]);
    const rows = this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM kb_sources WHERE ${where}
         ORDER BY scope ASC, created_at ASC`
      )
      .all(...params) as KnowledgeSourceRow[];
    return rows.map(mapRow);
  }

  search(refs: KnowledgeScopeRef[], query: string, limit = 8): KnowledgeSearchHit[] {
    const match = toKnowledgeMatchQuery(query);
    if (!match || refs.length === 0) return [];
    const where = refs.map(() => '(s.scope = ? AND s.scope_id = ?)').join(' OR ');
    const params = refs.flatMap((ref) => [ref.scope, ref.scopeId]);
    try {
      const rows = this.db
        .prepare(
          `SELECT f.source_id AS source_id, f.chunk_index AS chunk_index, s.title AS title,
                  s.kind AS kind, s.scope AS scope,
                  snippet(kb_chunks_fts, 3, '**', '**', ' … ', 48) AS excerpt,
                  bm25(kb_chunks_fts, 2.0, 1.0) AS rank
           FROM kb_chunks_fts f
           JOIN kb_sources s ON s.id = f.source_id
           WHERE kb_chunks_fts MATCH ? AND (${where})
           ORDER BY rank
           LIMIT ?`
        )
        .all(match, ...params, Math.max(1, Math.min(limit, 30))) as Array<{
        source_id: string;
        chunk_index: number;
        title: string;
        kind: KnowledgeSourceKind;
        scope: KnowledgeScope;
        excerpt: string;
        rank: number;
      }>;
      return rows.map((row) => ({
        sourceId: row.source_id,
        title: row.title,
        kind: row.kind,
        scope: row.scope,
        chunkIndex: Number(row.chunk_index),
        excerpt: row.excerpt,
        score: Math.round(-row.rank * 1000) / 1000,
      }));
    } catch {
      return [];
    }
  }

  getChunk(sourceId: string, chunkIndex: number): string | null {
    const row = this.db
      .prepare(`SELECT body FROM kb_chunks_fts WHERE source_id = ? AND chunk_index = ?`)
      .get(sourceId, chunkIndex) as { body: string } | undefined;
    return row ? row.body : null;
  }

  delete(id: string): boolean {
    this.db.prepare(`DELETE FROM kb_chunks_fts WHERE source_id = ?`).run(id);
    return this.db.prepare(`DELETE FROM kb_sources WHERE id = ?`).run(id).changes > 0;
  }

  deleteScope(ref: KnowledgeScopeRef): number {
    const ids = (
      this.db
        .prepare(`SELECT id FROM kb_sources WHERE scope = ? AND scope_id = ?`)
        .all(ref.scope, ref.scopeId) as Array<{ id: string }>
    ).map((row) => row.id);
    for (const id of ids) this.delete(id);
    return ids.length;
  }
}
