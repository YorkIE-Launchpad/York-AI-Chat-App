import type { SharedDocKind } from './types';

export function extForSharedDocKind(kind: SharedDocKind): string {
  return kind === 'markdown' ? 'md' : 'html';
}

export function safeSharedDocFileBase(title: string): string {
  const trimmed = title.trim() || 'document';
  return trimmed.replace(/[^\w.-]+/g, '_').slice(0, 80);
}

/** Title/base without a trailing kind extension (avoids hi.html → hi.html.html). */
export function sharedDocFileBase(title: string, kind: SharedDocKind): string {
  let base = safeSharedDocFileBase(title);
  const ext = extForSharedDocKind(kind);
  const suffix = `.${ext}`;
  if (base.toLowerCase().endsWith(suffix)) {
    base = base.slice(0, -suffix.length) || 'document';
  }
  const other = kind === 'html' ? '.md' : '.html';
  if (base.toLowerCase().endsWith(other)) {
    base = base.slice(0, -other.length) || 'document';
  }
  return base;
}

export function sharedDocFileName(title: string, kind: SharedDocKind): string {
  return `${sharedDocFileBase(title, kind)}.${extForSharedDocKind(kind)}`;
}

/** Fix stored paths that used the old double-extension naming. */
export function correctSharedDocRelativePath(
  existingLocalPath: string,
  title: string,
  kind: SharedDocKind,
  docId: string
): string {
  const canonicalName = sharedDocFileName(title, kind);
  const parts = existingLocalPath.replace(/\\/g, '/').split('/');
  const currentName = parts[parts.length - 1] ?? '';
  if (currentName === canonicalName) {
    return existingLocalPath;
  }
  if (/\.(html|md)\.(html|md)$/i.test(currentName)) {
    const dir = parts.slice(0, -1).join('/') || `shared/${docId}`;
    return `${dir}/${canonicalName}`;
  }
  return existingLocalPath;
}
