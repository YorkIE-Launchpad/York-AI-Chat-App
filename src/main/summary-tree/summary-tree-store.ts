/**
 * SQLite store for summary tree nodes.
 */
import type { DatabaseInstance } from '../db/database';
import type {
  SummaryTreeNode,
  SummaryTreeNodeKind,
  SummaryTreeStats,
} from '../../shared/summary-tree';

export interface SummaryTreeNodeRow {
  id: string;
  tree_key: string;
  kind: string;
  level: number;
  parent_id: string | null;
  title: string;
  body: string;
  wiki_page_id: string | null;
  score: number;
  x: number;
  y: number;
  created_at: number;
  updated_at: number;
}

export function mapSummaryTreeNodeRow(row: SummaryTreeNodeRow): SummaryTreeNode {
  return {
    id: row.id,
    treeKey: row.tree_key,
    kind: row.kind as SummaryTreeNodeKind,
    level: row.level as SummaryTreeNode['level'],
    parentId: row.parent_id,
    title: row.title,
    body: row.body,
    wikiPageId: row.wiki_page_id,
    score: row.score,
    x: row.x,
    y: row.y,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SummaryTreeStore {
  constructor(private readonly db: DatabaseInstance) {}

  clearAll(): void {
    this.db.prepare(`DELETE FROM summary_tree_nodes`).run();
  }

  insertMany(nodes: SummaryTreeNode[]): void {
    if (nodes.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO summary_tree_nodes
       (id, tree_key, kind, level, parent_id, title, body, wiki_page_id, score, x, y, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const run = this.db.raw.transaction((batch: SummaryTreeNode[]) => {
      for (const n of batch) {
        stmt.run(
          n.id,
          n.treeKey,
          n.kind,
          n.level,
          n.parentId,
          n.title,
          n.body,
          n.wikiPageId,
          n.score,
          n.x,
          n.y,
          n.createdAt,
          n.updatedAt
        );
      }
    });
    run(nodes);
  }

  replaceAll(nodes: SummaryTreeNode[]): void {
    const txn = this.db.raw.transaction((batch: SummaryTreeNode[]) => {
      this.db.prepare(`DELETE FROM summary_tree_nodes`).run();
      if (batch.length === 0) return;
      const stmt = this.db.prepare(
        `INSERT INTO summary_tree_nodes
         (id, tree_key, kind, level, parent_id, title, body, wiki_page_id, score, x, y, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const n of batch) {
        stmt.run(
          n.id,
          n.treeKey,
          n.kind,
          n.level,
          n.parentId,
          n.title,
          n.body,
          n.wikiPageId,
          n.score,
          n.x,
          n.y,
          n.createdAt,
          n.updatedAt
        );
      }
    });
    txn(nodes);
  }

  get(id: string): SummaryTreeNode | null {
    const row = this.db.prepare(`SELECT * FROM summary_tree_nodes WHERE id = ?`).get(id) as
      | SummaryTreeNodeRow
      | undefined;
    return row ? mapSummaryTreeNodeRow(row) : null;
  }

  listAll(): SummaryTreeNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM summary_tree_nodes ORDER BY tree_key ASC, level DESC, title ASC`)
      .all() as SummaryTreeNodeRow[];
    return rows.map(mapSummaryTreeNodeRow);
  }

  listByTree(treeKey: string): SummaryTreeNode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM summary_tree_nodes WHERE tree_key = ? ORDER BY level DESC, title ASC`
      )
      .all(treeKey) as SummaryTreeNodeRow[];
    return rows.map(mapSummaryTreeNodeRow);
  }

  listDocuments(limit = 20): SummaryTreeNode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM summary_tree_nodes WHERE kind = 'document' ORDER BY score DESC, title ASC LIMIT ?`
      )
      .all(limit) as SummaryTreeNodeRow[];
    return rows.map(mapSummaryTreeNodeRow);
  }

  listByKind(kind: SummaryTreeNodeKind, limit = 50): SummaryTreeNode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM summary_tree_nodes WHERE kind = ? ORDER BY score DESC, title ASC LIMIT ?`
      )
      .all(kind, limit) as SummaryTreeNodeRow[];
    return rows.map(mapSummaryTreeNodeRow);
  }

  stats(): SummaryTreeStats {
    const counts = this.db
      .prepare(
        `SELECT kind, COUNT(*) as c FROM summary_tree_nodes GROUP BY kind`
      )
      .all() as Array<{ kind: string; c: number }>;
    const byKind = new Map(counts.map((r) => [r.kind, r.c]));
    const nodeCount = [...byKind.values()].reduce((a, b) => a + b, 0);
    const treeCount =
      (
        this.db
          .prepare(`SELECT COUNT(DISTINCT tree_key) as c FROM summary_tree_nodes`)
          .get() as { c: number }
      )?.c ?? 0;
    const parentLinks =
      (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM summary_tree_nodes WHERE parent_id IS NOT NULL`)
          .get() as { c: number }
      )?.c ?? 0;

    return {
      nodeCount,
      linkCount: parentLinks,
      treeCount,
      sourceCount: byKind.get('source') ?? 0,
      l1Count: byKind.get('l1') ?? 0,
      l2Count: byKind.get('l2') ?? 0,
      documentCount: byKind.get('document') ?? 0,
    };
  }
}
