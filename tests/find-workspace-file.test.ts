import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildRevealSearchRoots,
  findFileByNameInRoots,
  isBareFilenameReference,
  shouldOpenMissingFileParent,
} from '../src/main/utils/find-workspace-file';

describe('find-workspace-file', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'york-reveal-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('detects bare filename references', () => {
    expect(isBareFilenameReference('report.pdf')).toBe(true);
    expect(isBareFilenameReference('outputs/report.pdf')).toBe(false);
    expect(isBareFilenameReference('/tmp/report.pdf')).toBe(false);
  });

  it('finds files under outputs/ when missing at workspace root', () => {
    const cwd = path.join(tempRoot, 'project');
    fs.mkdirSync(path.join(cwd, 'outputs'), { recursive: true });
    const filePath = path.join(cwd, 'outputs', 'rule-rubric.md.pdf');
    fs.writeFileSync(filePath, 'x');

    const found = findFileByNameInRoots('rule-rubric.md.pdf', [cwd]);
    expect(found).toBe(filePath);
  });

  it('prefers the newest match when multiple exist', () => {
    const cwd = path.join(tempRoot, 'project');
    fs.mkdirSync(path.join(cwd, 'old'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'new'), { recursive: true });
    const older = path.join(cwd, 'old', 'doc.pdf');
    const newer = path.join(cwd, 'new', 'doc.pdf');
    fs.writeFileSync(older, 'old');
    fs.writeFileSync(newer, 'new');
    const past = new Date(Date.now() - 60_000);
    const recent = new Date();
    fs.utimesSync(older, past, past);
    fs.utimesSync(newer, recent, recent);

    expect(findFileByNameInRoots('doc.pdf', [cwd])).toBe(newer);
  });

  it('does not open empty workspace roots for bare missing filenames', () => {
    const cwd = path.join(tempRoot, 'default_working_dir');
    fs.mkdirSync(cwd, { recursive: true });
    expect(
      shouldOpenMissingFileParent({
        originalPath: 'missing.pdf',
        resolvedPath: path.join(cwd, 'missing.pdf'),
        parentDir: cwd,
        workspaceRoots: [cwd],
      })
    ).toBe(false);
  });

  it('allows parent open for nested absolute-ish paths that are not workspace roots', () => {
    const nested = path.join(tempRoot, 'project', 'exports');
    fs.mkdirSync(nested, { recursive: true });
    expect(
      shouldOpenMissingFileParent({
        originalPath: path.join(nested, 'gone.pdf'),
        resolvedPath: path.join(nested, 'gone.pdf'),
        parentDir: nested,
        workspaceRoots: [path.join(tempRoot, 'project')],
      })
    ).toBe(true);
  });

  it('builds unique search roots', () => {
    const roots = buildRevealSearchRoots({
      cwd: '/a',
      defaultWorkingDir: '/a',
      userDataDefaultWorkingDir: '/b',
    });
    expect(roots).toEqual([path.resolve('/a'), path.resolve('/b')]);
  });
});
