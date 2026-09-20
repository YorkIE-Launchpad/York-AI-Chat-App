import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SharedDocKind, SharedDocWithAccess } from '../../shared/shared-docs/types';
import { sharedDocAccessCanEdit } from '../../shared/shared-docs/types';
import { ensureAuthenticatedSession } from '../auth/session';
import {
  downloadHubObjectToBuffer,
  fetchHubObjectLastModified,
  isRemoteS3Newer,
  sharedDocHubFolder,
  uploadFileToHubStorage,
} from '../hub/hub-storage';
import { resolveWorkspaceLocalPath } from '../utils/resolve-workspace-local-path';
import { remapCoworkVirtualPath } from '../agent/cowork-path-remap';
import { logError } from '../utils/logger';
import { createSharedDocInvite, joinSharedDoc } from './shared-docs-client';
import {
  getSharedDocLink,
  getSharedDocLinkByLocalPath,
  listSharedDocLinksForSession,
  type SharedDocLinkRow,
  upsertSharedDocLink,
} from './shared-doc-link-store';
import { assertCanEditSharedDoc } from './shared-doc-lock-service';
import { SHARED_DOC_LOCK_HELD } from '../../shared/shared-docs/lock-types';
import {
  isDoubleExtensionLeaf,
  sharedDocFileName,
  titleBaseFromPathOrTitle,
} from '../../shared/shared-docs/filename';

function safeFileBase(title: string): string {
  const trimmed = title.trim() || 'document';
  return trimmed.replace(/[^\w.-]+/g, '_').slice(0, 80);
}

function resolveSharedDocRelPath(
  doc: SharedDocWithAccess,
  link: SharedDocLinkRow | undefined
): string {
  const relDir = join('shared', doc.id);
  const canonical = join(relDir, sharedDocFileName(doc.title, doc.kind));
  if (!link?.local_path) {
    return canonical;
  }
  const leaf = link.local_path.split('/').pop() ?? '';
  if (isDoubleExtensionLeaf(leaf)) {
    return canonical;
  }
  return link.local_path;
}

function contentTypeForKind(kind: 'html' | 'markdown'): string {
  return kind === 'markdown' ? 'text/markdown' : 'text/html';
}

function previewKindFromPath(path: string): 'html' | 'markdown' {
  return path.toLowerCase().endsWith('.md') ? 'markdown' : 'html';
}

function decodeJwtClaims(idToken: string): { sub?: string; email?: string } {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')
    ) as { sub?: string; email?: string };
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined,
    };
  } catch {
    return {};
  }
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

function linkToDoc(link: SharedDocLinkRow): SharedDocWithAccess {
  return {
    id: link.doc_id,
    ownerSub: '',
    ownerEmail: '',
    title: link.title,
    kind: link.kind as SharedDocKind,
    s3Key: link.s3_key,
    s3UpdatedAt: link.s3_updated_at,
    contentType: contentTypeForKind(link.kind as SharedDocKind),
    permission: link.permission as SharedDocWithAccess['permission'],
  };
}

function backupLocalFile(absolutePath: string): string {
  const dir = dirname(absolutePath);
  const ext = extname(absolutePath);
  const base = safeFileBase(absolutePath.replace(ext, '').split(/[/\\]/).pop() ?? 'file');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = join(dir, `${base}.local-backup-${stamp}${ext}`);
  copyFileSync(absolutePath, backupPath);
  return backupPath;
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
  s3UpdatedAt?: string;
};

let syncNotifier: ((payload: SharedDocsSyncPayload) => void) | null = null;

export function setSharedDocsSyncNotifier(
  notifier: ((payload: SharedDocsSyncPayload) => void) | null
): void {
  syncNotifier = notifier;
}

export class SharedDocsService {
  private async writeRemoteToLink(input: {
    sessionId: string;
    cwd: string;
    doc: SharedDocWithAccess;
    localPath: string;
    backupBeforeWrite?: boolean;
  }): Promise<{ localPath: string; s3UpdatedAt: string; backupPath?: string }> {
    if (input.backupBeforeWrite) {
      if (!sharedDocAccessCanEdit(input.doc.permission)) {
        throw new Error('Read-only shared document');
      }
      await assertCanEditSharedDoc(input.doc.id, input.doc.permission);
    }
    const resolved = resolveInSession(input.cwd, input.localPath);
    let backupPath: string | undefined;
    if (input.backupBeforeWrite && existsSync(resolved.absolutePath)) {
      backupPath = backupLocalFile(resolved.absolutePath);
    }
    mkdirSync(dirname(resolved.absolutePath), { recursive: true });
    const { buffer, lastModified } = await downloadHubObjectToBuffer(input.doc.s3Key);
    writeFileSync(resolved.absolutePath, buffer);

    upsertSharedDocLink({
      docId: input.doc.id,
      sessionId: input.sessionId,
      localPath: resolved.relativePath,
      s3Key: input.doc.s3Key,
      s3UpdatedAt: lastModified,
      permission: input.doc.permission,
      title: input.doc.title,
      kind: input.doc.kind,
    });

    return { localPath: resolved.relativePath, s3UpdatedAt: lastModified, backupPath };
  }

  async shareLocalArtifact(input: {
    sessionId: string;
    cwd: string;
    localPath: string;
    title?: string;
  }): Promise<{ doc: SharedDocWithAccess; inviteToken: string }> {
    const resolved = resolveInSession(input.cwd, input.localPath);
    const absPath = resolved.absolutePath;
    const kind = previewKindFromPath(absPath);
    const title = input.title?.trim() || titleBaseFromPathOrTitle(absPath);

    const docId = randomUUID();
    const folder = sharedDocHubFolder(docId);
    const fileName = sharedDocFileName(title, kind);
    const upload = await uploadFileToHubStorage({
      filePath: absPath,
      folder,
      fileName,
    });

    const session = await ensureAuthenticatedSession();
    const claims = decodeJwtClaims(session.idToken);

    const doc: SharedDocWithAccess = {
      id: docId,
      ownerSub: claims.sub ?? '',
      ownerEmail: claims.email ?? session.user.email.toLowerCase(),
      title,
      kind,
      s3Key: upload.s3Key,
      s3UpdatedAt: upload.lastModified,
      contentType: contentTypeForKind(kind),
      permission: 'owner',
    };

    upsertSharedDocLink({
      docId,
      sessionId: input.sessionId,
      localPath: resolved.relativePath,
      s3Key: upload.s3Key,
      s3UpdatedAt: upload.lastModified,
      permission: 'owner',
      title,
      kind,
    });

    const invite = await createSharedDocInvite({
      docId,
      s3Key: upload.s3Key,
      title,
      kind,
      contentType: contentTypeForKind(kind),
      permission: 'view',
    });

    return { doc, inviteToken: invite.inviteToken };
  }

  async materializeSharedDoc(input: {
    sessionId: string;
    cwd: string;
    docId: string;
    doc?: SharedDocWithAccess;
  }): Promise<{ doc: SharedDocWithAccess; localPath: string }> {
    const link = getSharedDocLink(input.docId, input.sessionId);
    const doc =
      input.doc ??
      (link
        ? linkToDoc(link)
        : (() => {
            throw new Error('Document link not found — join with an invite first');
          })());

    const relPath = resolveSharedDocRelPath(doc, link);

    const result = await this.writeRemoteToLink({
      sessionId: input.sessionId,
      cwd: input.cwd,
      doc,
      localPath: relPath,
    });

    const withTimestamp: SharedDocWithAccess = { ...doc, s3UpdatedAt: result.s3UpdatedAt };
    return { doc: withTimestamp, localPath: result.localPath };
  }

  async syncLocalLinkIfRemoteNewer(input: {
    sessionId: string;
    cwd: string;
    docId: string;
  }): Promise<{ refreshed: boolean; s3UpdatedAt: string; localPath: string }> {
    const link = getSharedDocLink(input.docId, input.sessionId);
    if (!link) {
      throw new Error('Document link not found');
    }
    const remoteUpdatedAt = await fetchHubObjectLastModified(link.s3_key);
    if (!isRemoteS3Newer(remoteUpdatedAt, link.s3_updated_at)) {
      return {
        refreshed: false,
        s3UpdatedAt: link.s3_updated_at || remoteUpdatedAt,
        localPath: link.local_path,
      };
    }
    const doc = linkToDoc(link);
    const { localPath, s3UpdatedAt } = await this.writeRemoteToLink({
      sessionId: input.sessionId,
      cwd: input.cwd,
      doc: { ...doc, s3UpdatedAt: remoteUpdatedAt },
      localPath: link.local_path,
    });
    return { refreshed: true, s3UpdatedAt, localPath };
  }

  async restoreFromRemote(input: {
    sessionId: string;
    cwd: string;
    docId: string;
  }): Promise<{ localPath: string; s3UpdatedAt: string; backupPath?: string }> {
    const link = getSharedDocLink(input.docId, input.sessionId);
    if (!link) {
      throw new Error('Document link not found');
    }
    if (!sharedDocAccessCanEdit(link.permission)) {
      throw new Error('Read-only shared document');
    }
    const doc = linkToDoc(link);
    return this.writeRemoteToLink({
      sessionId: input.sessionId,
      cwd: input.cwd,
      doc,
      localPath: link.local_path,
      backupBeforeWrite: true,
    });
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
    if (!sharedDocAccessCanEdit(link.permission)) {
      throw new Error('Read-only shared document');
    }

    await assertCanEditSharedDoc(link.doc_id, link.permission);

    const remoteUpdatedAt = await fetchHubObjectLastModified(link.s3_key);
    if (isRemoteS3Newer(remoteUpdatedAt, link.s3_updated_at)) {
      throw new Error('version_conflict');
    }

    const resolved = resolveInSession(input.cwd, link.local_path);
    const folder = sharedDocHubFolder(link.doc_id);
    const upload = await uploadFileToHubStorage({
      filePath: resolved.absolutePath,
      folder,
      fileName: sharedDocFileName(link.title, link.kind as SharedDocKind),
    });

    const doc: SharedDocWithAccess = {
      ...linkToDoc(link),
      s3Key: upload.s3Key,
      s3UpdatedAt: upload.lastModified,
      permission: link.permission as SharedDocWithAccess['permission'],
    };

    upsertSharedDocLink({
      docId: link.doc_id,
      sessionId: input.sessionId,
      localPath: link.local_path,
      s3Key: upload.s3Key,
      s3UpdatedAt: upload.lastModified,
      permission: link.permission as SharedDocWithAccess['permission'],
      title: link.title,
      kind: link.kind as SharedDocKind,
    });

    return doc;
  }

  listDocsForSession(sessionId: string): SharedDocWithAccess[] {
    return listSharedDocLinksForSession(sessionId).map(linkToDoc);
  }

  joinByInvite(inviteToken: string): Promise<SharedDocWithAccess> {
    return joinSharedDoc(inviteToken.trim());
  }

  async createInvite(input: {
    docId: string;
    permission: 'view' | 'edit';
    sessionId: string;
  }): Promise<{ docId: string; permission: 'view' | 'edit'; inviteToken: string }> {
    const link = getSharedDocLink(input.docId, input.sessionId);
    if (!link) {
      throw new Error('Document link not found');
    }
    if (!sharedDocAccessCanEdit(link.permission)) {
      throw new Error('Read-only shared document');
    }
    return createSharedDocInvite({
      docId: link.doc_id,
      s3Key: link.s3_key,
      title: link.title,
      kind: link.kind as SharedDocKind,
      contentType: contentTypeForKind(link.kind as SharedDocKind),
      permission: input.permission,
    });
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
      if (!sharedDocAccessCanEdit(link.permission)) {
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
        s3UpdatedAt: doc.s3UpdatedAt,
      });
      return { synced: true };
    } catch (error) {
      logError('[SharedDocs] sync after write failed:', error);
      const message =
        error instanceof Error && (error as Error & { code?: string }).code === SHARED_DOC_LOCK_HELD
          ? SHARED_DOC_LOCK_HELD
          : error instanceof Error
            ? error.message
            : String(error);
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
