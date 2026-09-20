import type { SharedDocKind } from './types';

function extForKind(kind: SharedDocKind): string {
  return kind === 'markdown' ? 'md' : 'html';
}

function safeFileBase(title: string): string {
  const trimmed = title.trim() || 'document';
  return trimmed.replace(/[^\w.-]+/g, '_').slice(0, 80);
}

/** Strip a trailing .html / .md so we do not append the kind extension twice. */
export function titleBaseFromPathOrTitle(value: string): string {
  const trimmed = value.trim();
  const base = trimmed.split(/[/\\]/).pop() || trimmed;
  const lower = base.toLowerCase();
  if (lower.endsWith('.html')) return base.slice(0, -5);
  if (lower.endsWith('.md')) return base.slice(0, -3);
  if (lower.endsWith('.markdown')) return base.slice(0, -9);
  return base;
}

export function sharedDocFileName(title: string, kind: SharedDocKind): string {
  const base = safeFileBase(titleBaseFromPathOrTitle(title));
  return `${base}.${extForKind(kind)}`;
}

export function isDoubleExtensionLeaf(leaf: string): boolean {
  return /\.html\.html$/i.test(leaf) || /\.md\.md$/i.test(leaf);
}
