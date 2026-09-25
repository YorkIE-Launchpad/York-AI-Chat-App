/**
 * Short shared-document codes backed by Hub storage (no backend database).
 *
 * Hub `/api/storage/upload` always renames files to `<name>-<epochMs>-<rand>.<ext>`
 * and cannot list folders, so a code must carry the manifest's real key:
 * `<docId>-<epochMs base36>-<rand>` → `guild-collaboration/york-shared-docs/<docId>/m-<epochMs>-<rand>.json`.
 * Keys that do not follow that shape are carried verbatim as `k_<base64url(key)>`.
 */
import { randomBytes } from 'crypto';
import type { SharedDocKind, SharedDocPermission } from './types';

export const SHARED_DOCS_ROOT = 'guild-collaboration/york-shared-docs';
export const SHARED_DOC_MANIFEST_FILE_NAME = 'm.json';

const DOC_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const COMPACT_CODE_RE = /^([A-Za-z0-9]{8,32})-([0-9a-z]{6,12})-([0-9a-z]{1,12})$/;
const MANIFEST_LEAF_RE = /^m-(\d{10,16})-([0-9a-z]{1,12})\.json$/;
const WORKSPACE_DOC_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

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

export interface ParsedSharedDocCode {
  docId: string;
  manifestKey: string;
}

/** Folder id for a new shared doc, e.g. `k7Qm2nXp4R`. Alphanumeric so `-` can delimit codes. */
export function createSharedDocId(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const byte of bytes) out += DOC_ID_ALPHABET[byte % DOC_ID_ALPHABET.length];
  return out;
}

export function sharedDocFolder(docId: string): string {
  return `${SHARED_DOCS_ROOT}/${docId.trim()}`;
}

/** Build the invite code for a manifest uploaded under `sharedDocFolder(docId)`. */
export function sharedDocCodeFromManifestKey(docId: string, manifestKey: string): string {
  const key = manifestKey.trim();
  const leaf = key.split('/').pop() ?? '';
  const match = leaf.match(MANIFEST_LEAF_RE);
  if (/^[A-Za-z0-9]{8,32}$/.test(docId) && match && key === `${sharedDocFolder(docId)}/${leaf}`) {
    return `${docId}-${Number(match[1]).toString(36)}-${match[2]}`;
  }
  return `k_${Buffer.from(key, 'utf8').toString('base64url')}`;
}

/**
 * Accept a code (optionally prefixed `york-doc:`). Legacy backend JWTs have dots and
 * old UUID doc ids have four dashes; both return null so callers use the legacy path.
 */
export function parseSharedDocCode(input: string): ParsedSharedDocCode | null {
  const raw = input.trim().replace(/^york-doc:/i, '').trim();
  if (!raw || raw.includes('.')) return null;

  if (raw.startsWith('k_')) {
    let key = '';
    try {
      key = Buffer.from(raw.slice(2), 'base64url').toString('utf8');
    } catch {
      return null;
    }
    if (!key.startsWith(`${SHARED_DOCS_ROOT}/`) || key.includes('..')) return null;
    const docId = key.slice(SHARED_DOCS_ROOT.length + 1).split('/')[0] ?? '';
    if (!docId) return null;
    return { docId, manifestKey: key };
  }

  const match = raw.match(COMPACT_CODE_RE);
  if (!match) return null;
  const [, docId, ts36, rand] = match;
  const ts = Number.parseInt(ts36, 36);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return { docId, manifestKey: `${sharedDocFolder(docId)}/m-${ts}-${rand}.json` };
}

/** Pull a shared-doc id out of `.../shared/<id>/<file>`. */
export function sharedDocIdFromWorkspacePath(filePath: string): string | null {
  const normalized = filePath.trim().replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)shared\/([^/]+)\/[^/]+$/);
  if (!match?.[1] || !WORKSPACE_DOC_ID_RE.test(match[1])) return null;
  return match[1];
}

export function sharedDocContentFileName(kind: SharedDocKind): string {
  return kind === 'markdown' ? 'content.md' : 'content.html';
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
