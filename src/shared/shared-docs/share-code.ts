/**
 * Short shared-document codes. The code is the Hub/S3 folder id.
 * Metadata and bytes live in Hub storage, not a backend database.
 */
import { randomBytes } from 'crypto';
import type { SharedDocKind, SharedDocPermission } from './types';

const CODE_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export interface SharedDocManifest {
  id: string;
  title: string;
  kind: SharedDocKind;
  contentType: string;
  fileName: string;
  s3Key: string;
  ownerSub: string;
  ownerEmail: string;
  permission: SharedDocPermission;
  updatedAt: string;
}

/** Compact code, e.g. `k7Qm2nXp4Rwa`. */
export function createSharedDocCode(): string {
  return randomBytes(9).toString('base64url');
}

/** Pull a shared-doc id out of `.../shared/<id>/<file>`. */
export function sharedDocIdFromWorkspacePath(filePath: string): string | null {
  const normalized = filePath.trim().replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)shared\/([a-zA-Z0-9_-]{8,64})\/[^/]+$/);
  if (!match?.[1]) return null;
  return parseSharedDocCode(match[1]);
}

/**
 * Accept a short code or `york-doc:` prefix.
 * Legacy JWTs (three dot-separated parts) are not codes.
 */
export function parseSharedDocCode(input: string): string | null {
  const raw = input.trim().replace(/^york-doc:/i, '').trim();
  if (!raw || raw.includes('.')) return null;
  if (!CODE_RE.test(raw)) return null;
  return raw;
}

export function sharedDocContentFileName(kind: SharedDocKind): string {
  return kind === 'markdown' ? 'content.md' : 'content.html';
}

export function sharedDocManifestKey(docId: string): string {
  return `guild-collaboration/york-shared-docs/${docId.trim()}/manifest.json`;
}

export function sharedDocContentKey(docId: string, kind: SharedDocKind): string {
  return `guild-collaboration/york-shared-docs/${docId.trim()}/${sharedDocContentFileName(kind)}`;
}

export function parseSharedDocManifest(raw: string): SharedDocManifest | null {
  try {
    const value = JSON.parse(raw) as Partial<SharedDocManifest>;
    if (!value || typeof value !== 'object') return null;
    if (typeof value.id !== 'string' || !value.id.trim()) return null;
    if (typeof value.title !== 'string' || !value.title.trim()) return null;
    if (value.kind !== 'html' && value.kind !== 'markdown') return null;
    if (typeof value.s3Key !== 'string' || !value.s3Key.trim()) return null;
    if (value.permission !== 'view' && value.permission !== 'edit') return null;
    return {
      id: value.id.trim(),
      title: value.title.trim(),
      kind: value.kind,
      contentType:
        typeof value.contentType === 'string' && value.contentType.trim()
          ? value.contentType.trim()
          : value.kind === 'markdown'
            ? 'text/markdown'
            : 'text/html',
      fileName:
        typeof value.fileName === 'string' && value.fileName.trim()
          ? value.fileName.trim()
          : sharedDocContentFileName(value.kind),
      s3Key: value.s3Key.trim(),
      ownerSub: typeof value.ownerSub === 'string' ? value.ownerSub.trim() : '',
      ownerEmail: typeof value.ownerEmail === 'string' ? value.ownerEmail.trim().toLowerCase() : '',
      permission: value.permission,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    };
  } catch {
    return null;
  }
}
