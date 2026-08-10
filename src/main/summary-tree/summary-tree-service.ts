/**
 * Summary Tree service — build from wiki, graph export, reset.
 */
import type { DatabaseInstance } from '../db/database';
import type { WikiService } from '../wiki/wiki-service';
import { resolveWikiVaultRoot } from '../wiki/wiki-vault';
import {
  SUMMARY_TREE_DISPLAY_SOURCE_THRESHOLD,
  SUMMARY_TREE_WIKI_CAP,
  type SummaryTreeBuildResult,
  type SummaryTreeGraph,
  type SummaryTreeLink,
  type SummaryTreeNode,
  type SummaryTreeStats,
} from '../../shared/summary-tree';
import { layoutSummaryTreeNodes } from './summary-tree-layout';
import { sealAllTrees, wikiPagesToLeaves } from './summary-tree-seal';
import { SummaryTreeStore } from './summary-tree-store';
import { log } from '../utils/logger';

export class SummaryTreeService {
  private readonly store: SummaryTreeStore;
  private cwdHint: string | null = null;

  constructor(db: DatabaseInstance) {
    this.store = new SummaryTreeStore(db);
  }

  setCwdHint(cwd: string | null): void {
    this.cwdHint = cwd;
  }

  getVaultPath(): string {
    return resolveWikiVaultRoot(this.cwdHint);
  }

  stats(): SummaryTreeStats {
    return this.store.stats();
  }

  getNode(id: string): SummaryTreeNode | null {
    return this.store.get(id);
  }

  listDocuments(limit = 10): SummaryTreeNode[] {
    return this.store.listDocuments(limit);
  }

  reset(): SummaryTreeStats {
    this.store.clearAll();
    log('[SummaryTree] Cleared all nodes');
    return this.stats();
  }

  /**
   * Full rebuild from wiki pages. Replaces prior tree.
   */
  buildFromWiki(wikiService: WikiService): SummaryTreeBuildResult {
    const pages = wikiService.list(SUMMARY_TREE_WIKI_CAP);
    const leaves = wikiPagesToLeaves(pages);
    let nodes = sealAllTrees(leaves);
    nodes = layoutSummaryTreeNodes(nodes);
    this.store.replaceAll(nodes);
    const stats = this.store.stats();
    log(
      `[SummaryTree] Built ${stats.nodeCount} nodes / ${stats.linkCount} links across ${stats.treeCount} trees from ${pages.length} wiki pages`
    );
    return {
      ...stats,
      builtAt: Date.now(),
      wikiPageCount: pages.length,
    };
  }

  getGraph(options?: { includeSourceLeaves?: boolean }): SummaryTreeGraph {
    let nodes = this.store.listAll();
    const total = nodes.length;
    const includeSource =
      options?.includeSourceLeaves !== undefined
        ? options.includeSourceLeaves
        : total <= SUMMARY_TREE_DISPLAY_SOURCE_THRESHOLD;

    if (!includeSource) {
      nodes = nodes.filter((n) => n.kind !== 'source');
    }

    const links: SummaryTreeLink[] = [];
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      if (n.parentId && ids.has(n.parentId)) {
        links.push({
          id: `l_${n.parentId}_${n.id}`,
          from: n.parentId,
          to: n.id,
        });
      }
    }

    return {
      nodes,
      links,
      includesSourceLeaves: includeSource,
    };
  }
}
