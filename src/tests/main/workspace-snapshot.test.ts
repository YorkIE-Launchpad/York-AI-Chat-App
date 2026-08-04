import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkspaceTopLevelListing } from '../../main/utils/workspace-snapshot';

describe('buildWorkspaceTopLevelListing', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists files and directories with markers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-ws-'));
    temps.push(root);
    fs.mkdirSync(path.join(root, 'outputs'));
    fs.writeFileSync(path.join(root, 'notes.md'), 'hi');
    fs.writeFileSync(path.join(root, '.DS_Store'), '');

    const listing = buildWorkspaceTopLevelListing(root);
    expect(listing).toContain('outputs/');
    expect(listing).toContain('notes.md');
    expect(listing).not.toContain('.DS_Store');
  });

  it('reports empty and missing directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-ws-empty-'));
    temps.push(root);
    expect(buildWorkspaceTopLevelListing(root)).toBe('(empty directory)');
    expect(buildWorkspaceTopLevelListing(path.join(root, 'missing'))).toContain('missing');
  });
});
