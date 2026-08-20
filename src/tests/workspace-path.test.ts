import { describe, it, expect } from 'vitest';
import {
  extractOutputsRelativePath,
  resolvePathAgainstWorkspace,
} from '../shared/workspace-path';

describe('resolvePathAgainstWorkspace', () => {
  it('returns empty/falsy pathValue as-is', () => {
    expect(resolvePathAgainstWorkspace('')).toBe('');
  });

  it('returns absolute POSIX path as-is', () => {
    expect(resolvePathAgainstWorkspace('/usr/local/bin', '/home/user')).toBe('/usr/local/bin');
  });

  it('returns Windows drive path as-is', () => {
    expect(resolvePathAgainstWorkspace('C:\\Users\\foo', 'D:\\work')).toBe('C:\\Users\\foo');
  });

  it('resolves relative path against POSIX workspace', () => {
    expect(resolvePathAgainstWorkspace('src/main.ts', '/Users/haoqing/project')).toBe(
      '/Users/haoqing/project/src/main.ts'
    );
  });

  it('resolves relative path against Windows workspace', () => {
    expect(resolvePathAgainstWorkspace('src\\main.ts', 'C:\\Users\\foo\\project')).toBe(
      'C:\\Users\\foo\\project\\src\\main.ts'
    );
  });

  it('normalizes .. segments in relative path', () => {
    expect(resolvePathAgainstWorkspace('../other/file.ts', '/Users/haoqing/project/src')).toBe(
      '/Users/haoqing/project/other/file.ts'
    );
  });

  it('normalizes . segments', () => {
    expect(resolvePathAgainstWorkspace('./file.ts', '/Users/haoqing/project')).toBe(
      '/Users/haoqing/project/file.ts'
    );
  });

  it('remaps /workspace/ prefix to workspace path', () => {
    expect(resolvePathAgainstWorkspace('/workspace/src/index.ts', '/Users/haoqing/project')).toBe(
      '/Users/haoqing/project/src/index.ts'
    );
  });

  it('remaps exact /workspace root to workspace path', () => {
    expect(resolvePathAgainstWorkspace('/workspace', '/Users/haoqing/project')).toBe(
      '/Users/haoqing/project'
    );
  });

  it('remaps Windows workspace prefix to workspace path', () => {
    expect(resolvePathAgainstWorkspace('C:\\workspace\\src\\index.ts', 'D:\\myproject')).toBe(
      'D:\\myproject\\src\\index.ts'
    );
  });

  it('returns relative path as-is when no workspace provided', () => {
    expect(resolvePathAgainstWorkspace('src/main.ts')).toBe('src/main.ts');
    expect(resolvePathAgainstWorkspace('src/main.ts', null)).toBe('src/main.ts');
  });

  it('returns /workspace/ path as-is when no workspace provided', () => {
    expect(resolvePathAgainstWorkspace('/workspace/src/main.ts')).toBe('/workspace/src/main.ts');
  });

  it('remaps /mnt/user-data/ prefix to workspace path', () => {
    expect(
      resolvePathAgainstWorkspace('/mnt/user-data/outputs/foo-prd.md', '/Users/demo/project')
    ).toBe('/Users/demo/project/outputs/foo-prd.md');
  });

  it('remaps /mnt/workspace/ prefix to workspace path', () => {
    expect(resolvePathAgainstWorkspace('/mnt/workspace/src/index.ts', '/Users/demo/project')).toBe(
      '/Users/demo/project/src/index.ts'
    );
  });

  it('remaps exact /mnt/user-data root to workspace path', () => {
    expect(resolvePathAgainstWorkspace('/mnt/user-data', '/Users/demo/project')).toBe(
      '/Users/demo/project'
    );
  });

  it('does not remap WSL drive mounts under /mnt/c', () => {
    expect(resolvePathAgainstWorkspace('/mnt/c/work/demo.txt', '/Users/demo/project')).toBe(
      '/mnt/c/work/demo.txt'
    );
  });

  it('returns /mnt/user-data path as-is when no workspace provided', () => {
    expect(resolvePathAgainstWorkspace('/mnt/user-data/outputs/foo.md')).toBe(
      '/mnt/user-data/outputs/foo.md'
    );
  });

  it('extracts outputs-relative paths and rejects traversal', () => {
    expect(extractOutputsRelativePath('/Users/lay.s/outputs/report.html')).toBe(
      'outputs/report.html'
    );
    expect(
      extractOutputsRelativePath(
        '/Users/lay.s/outputs/sports-data-provider-executive/Sports-Data-Provider-Evaluation-2026-Client-Report.html'
      )
    ).toBe(
      'outputs/sports-data-provider-executive/Sports-Data-Provider-Evaluation-2026-Client-Report.html'
    );
    expect(extractOutputsRelativePath('outputs/deck.html')).toBe('outputs/deck.html');
    expect(extractOutputsRelativePath('/tmp/outputs/../secret.html')).toBeNull();
    expect(extractOutputsRelativePath('/tmp/other/file.html')).toBeNull();
  });

  it('remaps absolute outputs paths outside the workspace onto the workspace', () => {
    expect(
      resolvePathAgainstWorkspace(
        '/Users/lay.s/outputs/sports-data-provider-executive/report.html',
        '/Users/demo/project'
      )
    ).toBe('/Users/demo/project/outputs/sports-data-provider-executive/report.html');
  });

  it('does not remap absolute outputs paths already under the workspace', () => {
    expect(
      resolvePathAgainstWorkspace(
        '/Users/demo/project/outputs/report.html',
        '/Users/demo/project'
      )
    ).toBe('/Users/demo/project/outputs/report.html');
  });

  it('can keep the original outside-outputs path when remapping is disabled', () => {
    expect(
      resolvePathAgainstWorkspace(
        '/Users/kalravparsana/outputs/sarkhej-police-letter.html',
        '/Users/demo/default_working_dir',
        { remapOutsideOutputs: false }
      )
    ).toBe('/Users/kalravparsana/outputs/sarkhej-police-letter.html');
  });
});
