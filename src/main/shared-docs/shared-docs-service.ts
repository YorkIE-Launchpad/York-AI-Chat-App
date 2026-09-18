import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SharedDocWithAccess } from '../../shared/shared-docs/types';
import {
  downloadHubObjectToBuffer,
  sharedDocHubFolder,
  uploadFileToHubStorage,
} from '../hub/hub-storage';
import { resolveWorkspaceLocalPath } from '../utils/resolve-workspace-local-path';
import { remapCoworkVirtualPath } from '../agent/cowork-path-remap';
import { logError } from '../utils/logger';
import {
  createSharedDocInvite,
  createSharedDocRecord,
  getSharedDoc,
  joinSharedDoc,
  listSharedDocs,
  pushSharedDocVersion,
  updateSharedDocAcl,
} from './shared-docs-client';
import {
  getSharedDocLink,
  getSharedDocLinkByLocalPath,
  listSharedDocLinksForSession,
  upsertSharedDocLink,
} from './shared-doc-link-store';

function safeFileBase(title: string): string {
  const trimmed = title.trim() || 'document';
  return trimmed.replace(/[^\w.-]+/g, '_').slice(0, 80);
}

function extForKind(kind: 'html' | 'markdown'): string {
  return kind === 'markdown' ? 'md' : 'html';
}

function contentTypeForKind(kind: 'html' | 'markdown'): string {
  return kind === 'markdown' ? 'text/markdown' : 'text/html';
}

function previewKindFromPath(path: string): 'html' | 'markdown' {
  return path.toLowerCase().endsWith('.md') ? 'markdown' : 'html';
}

function resolveInSession(
  cwd: string,
  filePath: string
): { absolutePath: string; relativePath: string } {
  const resolved = resolveWorkspaceLocalPath(filePath, {
    preferredBaseDir: cwd,
    defaultWorkingDir: cwd,
    userDataDefaultWorkingDir: cwd,
  });
  if ('error' in resolved) {
    throw new Error(resolved.error);
  }
  const relativePath = relative(resolved.baseDir, resolved.path).replace(/\\/g, '/');
  return { absolutePath: resolved.path, relativePath };
}

export function workspaceRelativePath(workspaceRoot: string, agentPath: string): string {
  const remapped = remapCoworkVirtualPath(agentPath, workspaceRoot);
  const abs = isAbsolute(remapped) ? remapped : resolve(workspaceRoot, remapped);
  return relative(workspaceRoot, abs).replace(/\\/g, '/');
}

export type SharedDocsSyncPayload = {
  sessionId: string;
  localPath: string;
  synced: boolean;
  error?: string;
  version?: number;
};

let syncNotifier: ((payload: SharedDocsSyncPayload) => void) | null = null;

export function setSharedDocsSyncNotifier(
  notifier: ((payload: SharedDocsSyncPayload) => void) | null
): void {
  syncNotifier = notifier;
}

export class SharedDocsService {
  async shareLocalArtifact(input: {
    sessionId: string;
    cwd: string;
    localPath: string;
    title?: string;
  }): Promise<{ doc: SharedDocWithAccess; inviteToken: string }> {
    const resolved = resolveInSession(input.cwd, input.localPath);
    const absPath = resolved.absolutePath;
    const kind = previewKindFromPath(absPath);
    const title = input.title?.trim() || safeFileBase(absPath);

    const docId = randomUUID();
    const folder = sharedDocHubFolder(docId);
    const upload = await uploadFileToHubStorage({
      filePath: absPath,
      folder,
      fileName: `${safeFileBase(title)}.${extForKind(kind)}`,
    });

    const doc = await createSharedDocRecord({
      title,
      kind,
      s3Key: upload.s3Key,
      contentType: contentTypeForKind(kind),
    });

    const invite = await createSharedDocInvite(doc.id, 'view');

    upsertSharedDocLink({
      docId: doc.id,
      sessionId: input.sessionId,
      localPath: resolved.relativePath,
      s3Key: doc.s3Key,
      version: doc.version,
      permission: 'owner',
      title: doc.title,
      kind: doc.kind,
    });

    return { doc, inviteToken: invite.inviteToken };
  }

  async materializeSharedDoc(input: {
    sessionId: string;
    cwd: string;
    docId: string;
  }): Promise<{ doc: SharedDocWithAccess; localPath: string }> {
    const doc = await getSharedDoc(input.docId);
    const buffer = await downloadHubObjectToBuffer(doc.s3Key);
    const relDir = join('shared', doc.id);
    const fileName = `${safeFileBase(doc.title)}.${extForKind(doc.kind)}`;
    const relPath = join(relDir, fileName);
    const resolved = resolveInSession(input.cwd, relPath);
    mkdirSync(dirname(resolved.absolutePath), { recursive: true });
    writeFileSync(resolved.absolutePath, buffer);

    upsertSharedDocLink({
      docId: doc.id,
      sessionId: input.sessionId,
      localPath: resolved.relativePath,
      s3Key: doc.s3Key,
      version: doc.version,
      permission: doc.permission,
      title: doc.title,
      kind: doc.kind,
    });

    return { doc, localPath: resolved.relativePath };
  }

  async refreshSharedDocFromRemote(input: {
    sessionId: string;
    cwd: string;
    docId: string;
  }): Promise<{ localPath: string; version: number }> {
    const { doc, localPath } = await this.materializeSharedDoc(input);
    return { localPath, version: doc.version };
  }

  async syncLocalLinkIfRemoteNewer(input: {
    sessionId: string;
    cwd: string;
    docId: string;
  }): Promise<{ refreshed: boolean; version: number; localPath: string }> {
    const link = getSharedDocLink(input.docId, input.sessionId);
    const doc = await getSharedDoc(input.docId);
    if (!link || doc.version <= link.version) {
      return {
        refreshed: false,
        version: link?.version ?? doc.version,
        localPath: link?.local_path ?? '',
      };
    }
    const result = await this.refreshSharedDocFromRemote(input);
    return { refreshed: true, version: result.version, localPath: result.localPath };
  }

  async pushLocalEdits(input: {
    sessionId: string;
    cwd: string;
    localPath: string;
  }): Promise<SharedDocWithAccess> {
    const link = getSharedDocLinkByLocalPath(input.sessionId, input.localPath);
    if (!link) {
      throw new Error('Not a linked shared document');
    }
    if (link.permission !== 'edit' && link.permission !== 'owner') {
      throw new Error('Read-only shared document');
    }

    const resolved = resolveInSession(input.cwd, link.local_path);

    const folder = sharedDocHubFolder(link.doc_id);
    const upload = await uploadFileToHubStorage({
      filePath: resolved.absolutePath,
      folder,
      fileName: `${safeFileBase(link.title)}.${extForKind(link.kind as 'html' | 'markdown')}`,
    });

    try {
      const doc = await pushSharedDocVersion({
        docId: link.doc_id,
        s3Key: upload.s3Key,
        expectedVersion: link.version,
      });
      upsertSharedDocLink({
        docId: doc.id,
        sessionId: input.sessionId,
        localPath: link.local_path,
        s3Key: doc.s3Key,
        version: doc.version,
        permission: doc.permission,
        title: doc.title,
        kind: doc.kind,
      });
      return doc;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) {
        throw new Error('version_conflict');
      }
      throw error;
    }
  }

  listDocs(): Promise<SharedDocWithAccess[]> {
    return listSharedDocs();
  }

  joinByInvite(inviteToken: string): Promise<SharedDocWithAccess> {
    return joinSharedDoc(inviteToken.trim());
  }

  grantAcl(docId: string, principal: string, permission: 'view' | 'edit') {
    return updateSharedDocAcl(docId, principal.trim().toLowerCase(), permission);
  }

  createInvite(docId: string, permission: 'view' | 'edit') {
    return createSharedDocInvite(docId, permission);
  }

  getLinkForPath(sessionId: string, localPath: string) {
    return getSharedDocLinkByLocalPath(sessionId, localPath);
  }

  listLinksForSession(sessionId: string) {
    return listSharedDocLinksForSession(sessionId);
  }

  /** Called after agent writes a workspace file — best-effort sync. */
  async trySyncAfterFileWrite(input: {
    sessionId: string;
    cwd: string;
    relativePath: string;
  }): Promise<{ synced: boolean; error?: string }> {
    try {
      const link = getSharedDocLinkByLocalPath(input.sessionId, input.relativePath);
      if (!link) return { synced: false };
      if (link.permission !== 'edit' && link.permission !== 'owner') {
        return { synced: false };
      }
      const doc = await this.pushLocalEdits({
        sessionId: input.sessionId,
        cwd: input.cwd,
        localPath: input.relativePath,
      });
      syncNotifier?.({
        sessionId: input.sessionId,
        localPath: input.relativePath,
        synced: true,
        version: doc.version,
      });
      return { synced: true };
    } catch (error) {
      logError('[SharedDocs] sync after write failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      syncNotifier?.({
        sessionId: input.sessionId,
        localPath: input.relativePath,
        synced: false,
        error: message,
      });
      return { synced: false, error: message };
    }
  }
}

export const sharedDocsService = new SharedDocsService();
