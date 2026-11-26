/**
 * Write the brief HTML next to the session workspace so preview and Finder can open it.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { renderBrainstormBriefHtml } from '../../shared/brainstorm-brief-html';
import type { BrainstormDetail } from '../../shared/brainstorm-types';

export function writeBrainstormBriefFile(directory: string, detail: BrainstormDetail): string {
  mkdirSync(directory, { recursive: true });
  const slug = detail.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  const path = join(directory, `${slug || 'brainstorm'}-brief.html`);
  writeFileSync(path, renderBrainstormBriefHtml(detail), 'utf8');
  return path;
}
