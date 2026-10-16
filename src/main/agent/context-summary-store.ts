/**
 * Persists the latest compaction summary per chat so a rebuilt agent session
 * (app restart, cwd/tool/skill change, cache eviction) can recover the gist of
 * turns that no longer fit in the cold-start history budget.
 */
import type Database from 'better-sqlite3';

export interface ContextSummaryDb {
  prepare: (sql: string) => Database.Statement;
  exec: (sql: string) => unknown;
}

export interface ContextSummary {
  summary: string;
  updatedAt: number;
}

const MAX_SUMMARY_CHARS = 40_000;

export class ContextSummaryStore {
  constructor(private readonly db: ContextSummaryDb) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_context_summaries (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
  }

  get(sessionId: string): ContextSummary | null {
    const row = this.db
      .prepare(`SELECT summary, updated_at FROM session_context_summaries WHERE session_id = ?`)
      .get(sessionId) as { summary: string; updated_at: number } | undefined;
    return row ? { summary: row.summary, updatedAt: row.updated_at } : null;
  }

  save(sessionId: string, summary: string): void {
    const text = summary.trim().slice(0, MAX_SUMMARY_CHARS);
    if (!text) return;
    this.db
      .prepare(
        `INSERT INTO session_context_summaries (session_id, summary, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`
      )
      .run(sessionId, text, Date.now());
  }

  delete(sessionId: string): void {
    this.db.prepare(`DELETE FROM session_context_summaries WHERE session_id = ?`).run(sessionId);
  }
}
