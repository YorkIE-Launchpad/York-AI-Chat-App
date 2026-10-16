/**
 * Knowledge base sources: files and connector docs indexed for a chat or a
 * personal folder so every turn can search them without re-attaching.
 */

export type KnowledgeScope = 'chat' | 'folder';

export type KnowledgeSourceKind = 'file' | 'drive' | 'slack' | 'jira' | 'confluence';

export type KnowledgeSourceStatus = 'indexing' | 'ready' | 'error';

export interface KnowledgeSource {
  id: string;
  scope: KnowledgeScope;
  /** Session id for chat scope, folder id for folder scope. */
  scopeId: string;
  kind: KnowledgeSourceKind;
  title: string;
  /** Stable dedupe key within a scope (e.g. `file:report.pdf`, `drive:<fileId>`). */
  originKey: string;
  /** Absolute path the file was added from (used by refresh). */
  originPath?: string | null;
  url?: string | null;
  mimeType?: string | null;
  sizeBytes: number;
  charCount: number;
  chunkCount: number;
  status: KnowledgeSourceStatus;
  error?: string | null;
  meta?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeSearchHit {
  sourceId: string;
  title: string;
  kind: KnowledgeSourceKind;
  scope: KnowledgeScope;
  chunkIndex: number;
  excerpt: string;
  score: number;
}

export interface KnowledgeScopeRef {
  scope: KnowledgeScope;
  scopeId: string;
}

export interface KnowledgeAddFilesPayload extends KnowledgeScopeRef {
  paths: string[];
}

export interface KnowledgeAddReferencePayload extends KnowledgeScopeRef {
  source: Exclude<KnowledgeSourceKind, 'file'>;
  externalId: string;
  title: string;
  url?: string;
  meta?: Record<string, string>;
}

export interface KnowledgeSourcesChangedEvent {
  scope: KnowledgeScope;
  scopeId: string;
}
