import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  SharedDocKind,
  SharedDocPermission,
  SharedDocWithAccess,
} from '../../shared/shared-docs/types';
import { sharedDocAccessCanEdit } from '../../shared/shared-docs/types';
import {
  createSharedDocCode,
  parseSharedDocCode,
  parseSharedDocManifest,
  sharedDocContentFileName,
  sharedDocContentKey,
  sharedDocIdFromWorkspacePath,
  sharedDocManifestKey,
  type SharedDocManifest,
} from '../../shared/shared-docs/share-code';
import { ensureAuthenticatedSession } from '../auth/session';
import {
  downloadHubObjectToBuffer,
  fetchHubObjectLastModified,
  isRemoteS3Newer,
  sharedDocHubFolder,
  uploadBufferToHubStorage,
  uploadFileToHubStorage,
} from '../hub/hub-storage';
import { resolveWorkspaceLocalPath } from '../utils/resolve-workspace-local-path';
import { remapCoworkVirtualPath } from '../agent/cowork-path-remap';
import { logError } from '../utils/logger';
import { joinSharedDoc } from './shared-docs-client';
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
  filePath: string,
  allowMissing = false
): { absolutePath: string; relativePath: string } {
  const resolved = resolveWorkspaceLocalPath(filePath, {
    preferredBaseDir: cwd,
    defaultWorkingDir: cwd,
    userDataDefaultWorkingDir: cwd,
    allowMissing,
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
    localPath: link.local_path,
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
  private async downloadHubObject(keys: string[]): Promise<{ buffer: Buffer; lastModified: string }> {
    const unique = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
    let lastError: Error | null = null;
    for (const key of unique) {
      try {
        return await downloadHubObjectToBuffer(key);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw new Error(
      `Could not download shared document from Hub storage. ${lastError?.message || 'The object was not found in S3.'}`
    );
  }

  private async publishManifest(manifest: SharedDocManifest): Promise<void> {
    await uploadBufferToHubStorage({
      buffer: Buffer.from(JSON.stringify(manifest), 'utf8'),
      folder: sharedDocHubFolder(manifest.id),
      fileName: 'manifest.json',
      contentType: 'application/json',
    });
  }

  private async loadManifest(docId: string): Promise<SharedDocManifest> {
    const downloaded = await this.downloadHubObject([sharedDocManifestKey(docId)]);
    const manifest = parseSharedDocManifest(downloaded.buffer.toString('utf8'));
    if (!manifest) {
      throw new Error('Shared document manifest in Hub storage is invalid');
    }
    return manifest;
  }

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
    const resolved = resolveInSession(input.cwd, input.localPath, true);
    let backupPath: string | undefined;
    if (input.backupBeforeWrite && existsSync(resolved.absolutePath)) {
      backupPath = backupLocalFile(resolved.absolutePath);
    }
    const kind = input.doc.kind;
    let manifest: SharedDocManifest | null = null;
    try {
      manifest = await this.loadManifest(input.doc.id);
    } catch {
      manifest = null;
    }
    let downloaded: { buffer: Buffer; lastModified: string };
    try {
      const leaf = basename(input.localPath);
      downloaded = await this.downloadHubObject([
        manifest?.s3Key || '',
        input.doc.s3Key,
        sharedDocContentKey(input.doc.id, kind),
        leaf ? `${sharedDocHubFolder(input.doc.id)}/${leaf}` : '',
      ]);
    } catch (error) {
      if (existsSync(resolved.absolutePath)) {
        return {
          localPath: resolved.relativePath,
          s3UpdatedAt: input.doc.s3UpdatedAt,
          backupPath,
        };
      }
      throw error;
    }
    mkdirSync(dirname(resolved.absolutePath), { recursive: true });
    writeFileSync(resolved.absolutePath, downloaded.buffer);
    const lastModified = downloaded.lastModified;

    upsertSharedDocLink({
      docId: input.doc.id,
      sessionId: input.sessionId,
      localPath: resolved.relativePath,
      s3Key: manifest?.s3Key || input.doc.s3Key,
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
    permission?: SharedDocPermission;
  }): Promise<{ doc: SharedDocWithAccess; inviteToken: string }> {
    const resolved = resolveInSession(input.cwd, input.localPath);
    const absPath = resolved.absolutePath;
    const kind = previewKindFromPath(absPath);
    const title = input.title?.trim() || titleBaseFromPathOrTitle(absPath);

    const docId = createSharedDocCode();
    const folder = sharedDocHubFolder(docId);
    const fileName = sharedDocContentFileName(kind);
    const upload = await uploadFileToHubStorage({
      filePath: absPath,
      folder,
      fileName,
    });

    const session = await ensureAuthenticatedSession();
    const claims = decodeJwtClaims(session.idToken);
    const ownerSub = claims.sub ?? '';
    const ownerEmail = claims.email ?? session.user.email.toLowerCase();

    const doc: SharedDocWithAccess = {
      id: docId,
      ownerSub,
      ownerEmail,
      title,
      kind,
      s3Key: upload.s3Key,
      s3UpdatedAt: upload.lastModified,
      contentType: contentTypeForKind(kind),
      permission: 'owner',
      localPath: resolved.relativePath,
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

    await this.publishManifest({
      id: docId,
      title,
      kind,
      contentType: contentTypeForKind(kind),
      fileName,
      s3Key: upload.s3Key,
      ownerSub,
      ownerEmail,
      permission: input.permission === 'edit' ? 'edit' : 'view',
      updatedAt: upload.lastModified,
    });

    return { doc, inviteToken: docId };
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
    const resolved = resolveInSession(input.cwd, link.local_path, true);
    const missingLocal = !existsSync(resolved.absolutePath);
    let remoteUpdatedAt = link.s3_updated_at;
    try {
      remoteUpdatedAt = await fetchHubObjectLastModified(link.s3_key);
    } catch (error) {
      if (!missingLocal) throw error;
    }
    if (!missingLocal && !isRemoteS3Newer(remoteUpdatedAt, link.s3_updated_at)) {
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
    const kind = link.kind as SharedDocKind;
    const upload = await uploadFileToHubStorage({
      filePath: resolved.absolutePath,
      folder,
      fileName: sharedDocContentFileName(kind),
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

    const existingManifest = await this.loadManifest(link.doc_id).catch(() => null);
    await this.publishManifest({
      id: link.doc_id,
      title: link.title,
      kind,
      contentType: contentTypeForKind(kind),
      fileName: sharedDocContentFileName(kind),
      s3Key: upload.s3Key,
      ownerSub: existingManifest?.ownerSub || '',
      ownerEmail: existingManifest?.ownerEmail || '',
      permission:
        link.permission === 'owner'
          ? existingManifest?.permission || 'edit'
          : (link.permission as SharedDocPermission),
      updatedAt: upload.lastModified,
    });

    return doc;
  }

  /**
   * If `absolutePath` is `.../shared/<docId>/<file>` and the file is not on disk,
   * download it from Hub storage. Returns false when the path is not a shared doc.
   */
  async ensureLocalSharedFile(absolutePath: string): Promise<boolean> {
    if (existsSync(absolutePath)) return true;
    const docId = sharedDocIdFromWorkspacePath(absolutePath);
    if (!docId) return false;
    const leaf = basename(absolutePath);
    const kind = previewKindFromPath(absolutePath);
    let manifest: SharedDocManifest | null = null;
    try {
      manifest = await this.loadManifest(docId);
    } catch {
      manifest = null;
    }
    const downloaded = await this.downloadHubObject([
      manifest?.s3Key || '',
      sharedDocContentKey(docId, kind),
      leaf ? `${sharedDocHubFolder(docId)}/${leaf}` : '',
      sharedDocContentKey(docId, kind === 'html' ? 'markdown' : 'html'),
    ]);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, downloaded.buffer);
    return true;
  }

  async hydrateSession(sessionId: string, cwd: string): Promise<void> {
    for (const link of listSharedDocLinksForSession(sessionId)) {
      try {
        const resolved = resolveInSession(cwd, link.local_path, true);
        if (existsSync(resolved.absolutePath)) continue;
        await this.writeRemoteToLink({
          sessionId,
          cwd,
          doc: linkToDoc(link),
          localPath: link.local_path,
        });
      } catch (error) {
        logError('[SharedDocs] hydrate failed:', error);
      }
    }
  }

  listDocsForSession(sessionId: string): SharedDocWithAccess[] {
    return listSharedDocLinksForSession(sessionId).map(linkToDoc);
  }

  async joinByInvite(inviteToken: string): Promise<SharedDocWithAccess> {
    const code = parseSharedDocCode(inviteToken);
    if (!code) {
      return joinSharedDoc(inviteToken.trim());
    }
    const manifest = await this.loadManifest(code);
    const session = await ensureAuthenticatedSession();
    const claims = decodeJwtClaims(session.idToken);
    const permission: SharedDocWithAccess['permission'] =
      claims.sub && manifest.ownerSub && claims.sub === manifest.ownerSub
        ? 'owner'
        : manifest.permission;
    return {
      id: manifest.id,
      ownerSub: manifest.ownerSub,
      ownerEmail: manifest.ownerEmail,
      title: manifest.title,
      kind: manifest.kind,
      s3Key: manifest.s3Key,
      s3UpdatedAt: manifest.updatedAt,
      contentType: manifest.contentType,
      permission,
    };
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
    const kind = link.kind as SharedDocKind;
    const existingManifest = await this.loadManifest(link.doc_id).catch(() => null);
    await this.publishManifest({
      id: link.doc_id,
      title: link.title,
      kind,
      contentType: contentTypeForKind(kind),
      fileName: existingManifest?.fileName || sharedDocContentFileName(kind),
      s3Key: existingManifest?.s3Key || link.s3_key,
      ownerSub: existingManifest?.ownerSub || '',
      ownerEmail: existingManifest?.ownerEmail || '',
      permission: input.permission,
      updatedAt: link.s3_updated_at || new Date().toISOString(),
    });
    return { docId: link.doc_id, permission: input.permission, inviteToken: link.doc_id };
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
