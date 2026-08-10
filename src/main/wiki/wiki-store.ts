/**
 * SQLite-backed wiki page store + helpers.
 */
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance } from '../db/database';
import type { WikiPage, WikiPageInput, WikiSearchResult, WikiSourceRef } from '../../shared/wiki';

export interface WikiPageRow {
  id: string;
  path: string;
  title: string;
  body: string;
  score: number;
  sources: string;
  division_key: string | null;
  created_at: number;
  updated_at: number;
}

function parseSources(raw: string | null | undefined): WikiSourceRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is WikiSourceRef =>
        !!s && typeof s === 'object' && typeof (s as WikiSourceRef).kind === 'string'
    );
  } catch {
    return [];
  }
}

export function mapWikiPageRow(row: WikiPageRow): WikiPage {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    body: row.body,
    score: row.score,
    sources: parseSources(row.sources),
    divisionKey: row.division_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slugifyPathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

export function buildWikiPath(category: string, title: string): string {
  return `${slugifyPathSegment(category)}/${slugifyPathSegment(title)}`;
}

export class WikiStore {
  constructor(private readonly db: DatabaseInstance) {}

  upsertByPath(input: WikiPageInput): WikiPage {
    const now = Date.now();
    const existing = this.getByPath(input.path);
    const sources = JSON.stringify(input.sources ?? existing?.sources ?? []);
    if (existing) {
      this.db
        .prepare(
          `UPDATE wiki_pages
           SET title = ?, body = ?, score = ?, sources = ?, division_key = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.title,
          input.body,
          input.score ?? existing.score,
          sources,
          input.divisionKey ?? existing.divisionKey,
          now,
          existing.id
        );
      return this.get(existing.id)!;
    }

    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO wiki_pages
         (id, path, title, body, score, sources, division_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.path,
        input.title,
        input.body,
        input.score ?? 0,
        sources,
        input.divisionKey ?? null,
        now,
        now
      );
    return this.get(id)!;
  }

  get(id: string): WikiPage | null {
    const row = this.db.prepare(`SELECT * FROM wiki_pages WHERE id = ?`).get(id) as
      | WikiPageRow
      | undefined;
    return row ? mapWikiPageRow(row) : null;
  }

  getByPath(pagePath: string): WikiPage | null {
    const row = this.db.prepare(`SELECT * FROM wiki_pages WHERE path = ?`).get(pagePath) as
      | WikiPageRow
      | undefined;
    return row ? mapWikiPageRow(row) : null;
  }

  list(limit = 200): WikiPage[] {
    const rows = this.db
      .prepare(`SELECT * FROM wiki_pages ORDER BY path ASC LIMIT ?`)
      .all(limit) as WikiPageRow[];
    return rows.map(mapWikiPageRow);
  }

  search(query: string, limit = 20): WikiSearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM wiki_pages
         WHERE lower(title) LIKE ? OR lower(body) LIKE ? OR lower(path) LIKE ?
         ORDER BY score DESC, updated_at DESC
         LIMIT ?`
      )
      .all(`%${q}%`, `%${q}%`, `%${q}%`, limit) as WikiPageRow[];

    return rows.map((row) => {
      const page = mapWikiPageRow(row);
      const bodyLower = page.body.toLowerCase();
      const idx = bodyLower.indexOf(q);
      const start = idx >= 0 ? Math.max(0, idx - 40) : 0;
      const excerpt = page.body.slice(start, start + 160).replace(/\s+/g, ' ').trim();
      return {
        id: page.id,
        path: page.path,
        title: page.title,
        score: page.score,
        excerpt: excerpt || page.title,
        divisionKey: page.divisionKey,
        updatedAt: page.updatedAt,
      };
    });
  }

  updateBody(id: string, body: string, title?: string): WikiPage | null {
    const existing = this.get(id);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare(`UPDATE wiki_pages SET body = ?, title = ?, updated_at = ? WHERE id = ?`)
      .run(body, title ?? existing.title, now, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM wiki_pages WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM wiki_pages`).get() as { c: number };
    return row?.c ?? 0;
  }
}
