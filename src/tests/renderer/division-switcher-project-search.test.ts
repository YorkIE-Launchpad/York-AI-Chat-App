/**
 * Workspace dropdown project picker must expose a local search field so long
 * company-project lists can be filtered without scrolling.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function readSrc(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('workspace dropdown project search', () => {
  it('filters the company project list with a search input', () => {
    const switcher = readSrc('renderer/components/DivisionSwitcher.tsx');
    expect(switcher).toContain('filterCompanyProjects');
    expect(switcher).toContain('Search projects');
    expect(switcher).toContain('No matching projects');
    expect(switcher).toContain('projectQuery');
  });
});
