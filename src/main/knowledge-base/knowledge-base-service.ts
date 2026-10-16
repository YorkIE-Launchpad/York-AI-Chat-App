/**
 * Knowledge base orchestration: ingest files / connector docs into a chat or
 * folder scope, refresh snapshots, and answer scoped search/read for the agent.
 */
import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import * as path from 'path';
import type { MCPManager } from '../mcp/mcp-manager';
import { resolveExternalReference } from '../references/reference-service';
import { logWarn } from '../utils/logger';
import type {
  KnowledgeAddReferencePayload,
  KnowledgeScopeRef,
  KnowledgeSearchHit,
  KnowledgeSource,
  KnowledgeSourcesChangedEvent,
} from '../../shared/knowledge-base';
import {
  chunkKnowledgeText,
  extractKnowledgeText,
  isImagePath,
  normalizeExtractedText,
} from './knowledge-base-extract';
import { KnowledgeBaseStore, type KnowledgeBaseDb } from './knowledge-base-store';

export interface KnowledgeBaseServiceDeps {
  getMcpManager?: () => MCPManager | null;
  /** Folder id the chat currently lives in (personal folder division), if any. */
  resolveFolderId?: (sessionId: string) => string | null;
  onChanged?: (event: KnowledgeSourcesChangedEvent) => void;
}

export interface KnowledgeSessionRef {
  id: string;
  folderId?: string | null;
  division?: string | null;
}

const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = 60_000;

export class KnowledgeBaseService {
  private readonly store: KnowledgeBaseStore;

  constructor(
    db: KnowledgeBaseDb,
    private readonly deps: KnowledgeBaseServiceDeps = {}
  ) {
    this.store = new KnowledgeBaseStore(db);
  }

  scopesForSession(session: KnowledgeSessionRef): KnowledgeScopeRef[] {
    const scopes: KnowledgeScopeRef[] = [{ scope: 'chat', scopeId: session.id }];
    const folderId = this.deps.resolveFolderId
      ? this.deps.resolveFolderId(session.id)
      : session.division === 'folder'
        ? session.folderId
        : null;
    if (folderId) scopes.push({ scope: 'folder', scopeId: folderId });
    return scopes;
  }

  list(refs: KnowledgeScopeRef[]): KnowledgeSource[] {
    return this.store.list(refs);
  }

  listForSession(session: KnowledgeSessionRef): KnowledgeSource[] {
    return this.store.list(this.scopesForSession(session));
  }

  get(id: string): KnowledgeSource | null {
    return this.store.get(id);
  }

  /** True when the source belongs to the chat itself or the chat's folder. */
  canAccess(session: KnowledgeSessionRef, sourceId: string): boolean {
    const source = this.store.get(sourceId);
    if (!source) return false;
    return this.scopesForSession(session).some(
      (ref) => ref.scope === source.scope && ref.scopeId === source.scopeId
    );
  }

  search(session: KnowledgeSessionRef, query: string, limit?: number, sourceId?: string) {
    const scopes = this.scopesForSession(session);
    const hits = this.store.search(scopes, query, sourceId ? 30 : limit);
    const filtered: KnowledgeSearchHit[] = sourceId
      ? hits.filter((hit) => hit.sourceId === sourceId).slice(0, limit ?? 8)
      : hits;
    return filtered;
  }

  read(
    session: KnowledgeSessionRef,
    sourceId: string,
    offset = 0,
    maxChars = DEFAULT_READ_CHARS
  ): { source: KnowledgeSource; text: string; offset: number; total: number } | null {
    if (!this.canAccess(session, sourceId)) return null;
    const source = this.store.get(sourceId);
    const content = this.store.getContent(sourceId);
    if (!source || content === null) return null;
    const start = Math.max(0, Math.min(offset, content.length));
    const size = Math.max(500, Math.min(maxChars, MAX_READ_CHARS));
    return {
      source,
      text: content.slice(start, start + size),
      offset: start,
      total: content.length,
    };
  }

  /** Character offset of a chunk within the source's full text, or null. */
  chunkOffset(sourceId: string, chunkIndex: number): number | null {
    const chunk = this.store.getChunk(sourceId, chunkIndex);
    const content = this.store.getContent(sourceId);
    if (!chunk || content === null) return null;
    const index = content.indexOf(chunk);
    return index >= 0 ? index : null;
  }

  /**
   * Register a local file and index it. Resolves once indexing finishes
   * (success or error); the returned source reflects the final state.
   */
  async addFile(
    ref: KnowledgeScopeRef,
    filePath: string,
    options: { title?: string; originPath?: string; mimeType?: string } = {}
  ): Promise<KnowledgeSource | null> {
    if (isImagePath(filePath)) return null;
    const title = options.title || path.basename(filePath);
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(filePath)).size;
    } catch {
      sizeBytes = 0;
    }
    const pending = this.store.upsertPending({
      ...ref,
      kind: 'file',
      title,
      originKey: `file:${title.toLowerCase()}`,
      originPath: options.originPath || filePath,
      mimeType: options.mimeType ?? null,
      sizeBytes,
    });
    this.emit(ref);
    await this.indexFile(pending.id, filePath);
    return this.store.get(pending.id);
  }

  async addFiles(ref: KnowledgeScopeRef, paths: string[]): Promise<KnowledgeSource[]> {
    const results: KnowledgeSource[] = [];
    for (const filePath of paths) {
      const source = await this.addFile(ref, filePath);
      if (source) results.push(source);
    }
    return results;
  }

  /** Register a connector document; fetches full text unless `text` is provided. */
  async addReference(
    payload: KnowledgeAddReferencePayload,
    text?: string
  ): Promise<KnowledgeSource> {
    const ref: KnowledgeScopeRef = { scope: payload.scope, scopeId: payload.scopeId };
    const pending = this.store.upsertPending({
      ...ref,
      kind: payload.source,
      title: payload.title,
      originKey: `${payload.source}:${payload.externalId}`,
      url: payload.url ?? null,
      meta: { ...(payload.meta || {}), externalId: payload.externalId },
    });
    this.emit(ref);
    if (text !== undefined) {
      this.writeContent(pending.id, text);
    } else {
      await this.indexReference(pending);
    }
    this.emit(ref);
    return this.store.get(pending.id)!;
  }

  async refresh(id: string): Promise<KnowledgeSource | null> {
    const source = this.store.get(id);
    if (!source) return null;
    const ref = { scope: source.scope, scopeId: source.scopeId };
    this.store.upsertPending({
      ...ref,
      kind: source.kind,
      title: source.title,
      originKey: source.originKey,
    });
    this.emit(ref);
    if (source.kind === 'file') {
      const original = source.originPath;
      if (!original || !existsSync(original)) {
        this.store.setError(id, 'The original file is no longer available. Re-add it to update.');
        this.emit(ref);
        return this.store.get(id);
      }
      await this.indexFile(id, original);
    } else {
      await this.indexReference(source);
    }
    return this.store.get(id);
  }

  remove(id: string): boolean {
    const source = this.store.get(id);
    if (!source) return false;
    const removed = this.store.delete(id);
    if (removed) this.emit({ scope: source.scope, scopeId: source.scopeId });
    return removed;
  }

  deleteScope(ref: KnowledgeScopeRef): void {
    if (this.store.deleteScope(ref) > 0) this.emit(ref);
  }

  buildPromptPrefix(sources: KnowledgeSource[]): string | undefined {
    const usable = sources.filter((source) => source.status !== 'error');
    if (usable.length === 0) return undefined;
    const shown = usable.slice(0, 40);
    const lines = shown.map((source) => {
      const parts = [kindLabel(source), formatSize(source)];
      if (source.scope === 'folder') parts.push('folder');
      if (source.status === 'indexing') parts.push('still indexing');
      return `- ${source.title} (id: ${source.id}; ${parts.filter(Boolean).join(', ')})`;
    });
    if (usable.length > shown.length) {
      lines.push(`- …and ${usable.length - shown.length} more (use sources_list)`);
    }
    return [
      '<knowledge_sources>',
      `This chat has a knowledge base of ${usable.length} source(s) the user added (attachments, uploads, connector docs). They stay available on every turn, so the user may refer to them without re-attaching.`,
      ...lines,
      'When a question could be answered from these sources, call sources_search first, then sources_read for fuller context. Name the source you relied on. If the sources do not cover the question, say so before using other knowledge.',
      '</knowledge_sources>',
    ].join('\n');
  }

  private async indexFile(id: string, filePath: string): Promise<void> {
    const source = this.store.get(id);
    try {
      const text = await extractKnowledgeText(filePath);
      this.writeContent(id, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn('[KnowledgeBase] File indexing failed', filePath, message);
      this.store.setError(id, message);
    }
    if (source) this.emit({ scope: source.scope, scopeId: source.scopeId });
  }

  private async indexReference(source: KnowledgeSource): Promise<void> {
    const mcpManager = this.deps.getMcpManager?.() ?? null;
    const ref = { scope: source.scope, scopeId: source.scopeId };
    if (!mcpManager) {
      this.store.setError(source.id, 'Connectors are not ready yet. Try refreshing in a moment.');
      this.emit(ref);
      return;
    }
    const externalId = source.meta?.externalId || source.originKey.split(':').slice(1).join(':');
    try {
      const resolved = await resolveExternalReference(
        mcpManager,
        {
          source: source.kind as KnowledgeAddReferencePayload['source'],
          externalId,
          title: source.title,
          url: source.url ?? undefined,
          meta: source.meta,
        },
        { full: true }
      );
      if (resolved.error || !resolved.text.trim()) {
        this.store.setError(source.id, resolved.error || 'No content returned.');
      } else {
        this.writeContent(source.id, resolved.text, resolved.title);
      }
    } catch (error) {
      this.store.setError(source.id, error instanceof Error ? error.message : String(error));
    }
    this.emit(ref);
  }

  private writeContent(id: string, rawText: string, title?: string): void {
    const text = normalizeExtractedText(rawText);
    if (!text) {
      this.store.setError(id, 'No text found.');
      return;
    }
    this.store.setContent(id, text, chunkKnowledgeText(text), title);
  }

  private emit(ref: KnowledgeScopeRef): void {
    try {
      this.deps.onChanged?.({ scope: ref.scope, scopeId: ref.scopeId });
    } catch {
      /* renderer may be gone */
    }
  }
}

function kindLabel(source: KnowledgeSource): string {
  if (source.kind !== 'file') {
    return source.kind === 'drive'
      ? 'Google Drive'
      : source.kind[0].toUpperCase() + source.kind.slice(1);
  }
  const ext = path.extname(source.title).slice(1).toUpperCase();
  return ext || 'file';
}

function formatSize(source: KnowledgeSource): string {
  if (!source.charCount) return '';
  const words = Math.round(source.charCount / 6);
  return words >= 1000 ? `~${Math.round(words / 100) / 10}k words` : `~${words} words`;
}
