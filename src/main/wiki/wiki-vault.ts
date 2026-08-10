/**
 * Markdown vault mirror for wiki pages under workspace `memory-wiki/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { configStore } from '../config/config-store';
import type { WikiPage } from '../../shared/wiki';
import { logWarn } from '../utils/logger';

const VAULT_DIR_NAME = 'memory-wiki';

export function resolveWikiVaultRoot(cwdHint?: string | null): string {
  const configured = (configStore.get('defaultWorkdir') || '').trim();
  const base = (cwdHint || configured || app.getPath('userData')).trim();
  return path.join(path.resolve(base), VAULT_DIR_NAME);
}

function pageFilePath(vaultRoot: string, pagePath: string): string {
  const normalized = pagePath.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new Error(`Unsafe wiki path: ${pagePath}`);
  }
  return path.join(vaultRoot, ...segments) + '.md';
}

function frontmatter(page: WikiPage): string {
  const sources = JSON.stringify(page.sources);
  return [
    '---',
    `id: ${page.id}`,
    `path: ${page.path}`,
    `title: ${JSON.stringify(page.title)}`,
    `score: ${page.score}`,
    `divisionKey: ${page.divisionKey ?? ''}`,
    `updatedAt: ${page.updatedAt}`,
    `sources: ${sources}`,
    '---',
    '',
  ].join('\n');
}

export function writeWikiVaultPage(page: WikiPage, cwdHint?: string | null): string {
  const vaultRoot = resolveWikiVaultRoot(cwdHint);
  const filePath = pageFilePath(vaultRoot, page.path);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = `${frontmatter(page)}# ${page.title}\n\n${page.body.trim()}\n`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

export function deleteWikiVaultPage(pagePath: string, cwdHint?: string | null): void {
  try {
    const filePath = pageFilePath(resolveWikiVaultRoot(cwdHint), pagePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    logWarn('[WikiVault] Failed to delete vault page', { pagePath, error });
  }
}

export function ensureWikiVaultReadme(cwdHint?: string | null): void {
  const vaultRoot = resolveWikiVaultRoot(cwdHint);
  fs.mkdirSync(vaultRoot, { recursive: true });
  const readme = path.join(vaultRoot, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        '# Memory Wiki vault',
        '',
        'Editable Markdown mirror of York company memory pages.',
        'Edits made in the app write both SQLite and this vault.',
        '',
      ].join('\n'),
      'utf8'
    );
  }
}
