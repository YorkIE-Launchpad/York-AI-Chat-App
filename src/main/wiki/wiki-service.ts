/**
 * Memory Wiki service — SQLite primary + Markdown vault mirror.
 */
import type { DatabaseInstance } from '../db/database';
import type { MatterItem } from '../../shared/matter';
import type {
  WikiPage,
  WikiPageInput,
  WikiSearchResult,
  WikiTreeNode,
} from '../../shared/wiki';
import { log, logError, logWarn } from '../utils/logger';
import {
  compileConnectorArtifactToWikiPage,
  compileMeetingToWikiPage,
  compileMatterItemToWikiPage,
} from './wiki-compiler';
import { WikiStore } from './wiki-store';
import { deleteWikiVaultPage, ensureWikiVaultReadme, writeWikiVaultPage } from './wiki-vault';

export class WikiService {
  private readonly store: WikiStore;
  private cwdHint: string | null = null;

  constructor(db: DatabaseInstance) {
    this.store = new WikiStore(db);
    try {
      ensureWikiVaultReadme(this.cwdHint);
    } catch (error) {
      logWarn('[Wiki] Failed to initialize vault', error);
    }
  }

  setCwdHint(cwd: string | null): void {
    this.cwdHint = cwd;
  }

  private mirror(page: WikiPage): void {
    try {
      writeWikiVaultPage(page, this.cwdHint);
    } catch (error) {
      logWarn('[Wiki] Vault write failed', { path: page.path, error });
    }
  }

  upsert(input: WikiPageInput): WikiPage {
    const page = this.store.upsertByPath(input);
    this.mirror(page);
    return page;
  }

  get(id: string): WikiPage | null {
    return this.store.get(id);
  }

  getByPath(pagePath: string): WikiPage | null {
    return this.store.getByPath(pagePath);
  }

  list(limit?: number): WikiPage[] {
    return this.store.list(limit);
  }

  search(query: string, limit?: number): WikiSearchResult[] {
    return this.store.search(query, limit);
  }

  /**
   * User edit — vault + SQLite. Never called from Incognito session content paths.
   */
  updatePage(id: string, body: string, title?: string): WikiPage | null {
    const page = this.store.updateBody(id, body, title);
    if (page) this.mirror(page);
    return page;
  }

  deletePage(id: string): boolean {
    const existing = this.store.get(id);
    if (!existing) return false;
    const ok = this.store.delete(id);
    if (ok) deleteWikiVaultPage(existing.path, this.cwdHint);
    return ok;
  }

  count(): number {
    return this.store.count();
  }

  listTree(): WikiTreeNode[] {
    const pages = this.store.list(500);
    const root: WikiTreeNode = { path: '', title: 'wiki', isPage: false, children: [] };

    const findOrCreate = (parent: WikiTreeNode, segment: string, fullPath: string): WikiTreeNode => {
      let child = parent.children.find((c) => c.path === fullPath || c.title === segment);
      if (!child) {
        child = { path: fullPath, title: segment, isPage: false, children: [] };
        parent.children.push(child);
      }
      return child;
    };

    for (const page of pages) {
      const segments = page.path.split('/').filter(Boolean);
      let current = root;
      let acc = '';
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        acc = acc ? `${acc}/${segment}` : segment;
        const isLeaf = i === segments.length - 1;
        if (isLeaf) {
          current.children.push({
            path: page.path,
            title: page.title,
            isPage: true,
            children: [],
          });
        } else {
          current = findOrCreate(current, segment, acc);
        }
      }
    }

    return root.children;
  }

  /**
   * Matter post-collect hook — does not depend on chat Incognito sessions.
   */
  ingestMatterItems(items: MatterItem[]): { upserted: number } {
    let upserted = 0;
    for (const item of items) {
      try {
        this.upsert(compileMatterItemToWikiPage(item));
        upserted += 1;
      } catch (error) {
        logError('[Wiki] Failed to ingest Matter item', item.id, error);
      }
    }
    if (upserted > 0) {
      log(`[Wiki] Ingested ${upserted} Matter page(s)`);
    }
    return { upserted };
  }

  ingestMeeting(meeting: {
    id: string;
    title: string;
    startedAt: number;
    notes: { title?: string; summary?: string; actionItems?: string[]; keyTopics?: string[] };
  }): WikiPage {
    return this.upsert(compileMeetingToWikiPage(meeting));
  }

  ingestConnectorArtifact(input: {
    connectorId: string;
    externalId: string;
    title: string;
    summary: string;
    content: string;
  }): WikiPage {
    return this.upsert(compileConnectorArtifactToWikiPage(input));
  }
}
