import { describe, expect, it } from 'vitest';
import {
  remapCoworkVirtualPath,
  remapCoworkVirtualPathsInCommand,
} from '../src/main/agent/cowork-path-remap';

describe('remapCoworkVirtualPath', () => {
  const cwd = '/Users/demo/project';

  it('maps /mnt/user-data outputs into workspace-relative paths', () => {
    expect(remapCoworkVirtualPath('/mnt/user-data/outputs/foo-prd.md', cwd)).toBe(
      'outputs/foo-prd.md'
    );
  });

  it('maps /mnt/workspace paths into workspace-relative paths', () => {
    expect(remapCoworkVirtualPath('/mnt/workspace/src/index.ts', cwd)).toBe('src/index.ts');
  });

  it('maps /workspace paths into workspace-relative paths', () => {
    expect(remapCoworkVirtualPath('/workspace/york-ie-altitude-artifact', cwd)).toBe(
      'york-ie-altitude-artifact'
    );
    expect(remapCoworkVirtualPath('/workspace/outputs/deck.pptx', cwd)).toBe('outputs/deck.pptx');
  });

  it('maps the virtual root itself to the workspace directory', () => {
    expect(remapCoworkVirtualPath('/mnt/user-data', cwd)).toBe('.');
    expect(remapCoworkVirtualPath('/mnt/workspace', cwd)).toBe('.');
    expect(remapCoworkVirtualPath('/workspace', cwd)).toBe('.');
  });

  it('leaves relative and unrelated absolute paths unchanged', () => {
    expect(remapCoworkVirtualPath('outputs/foo-prd.md', cwd)).toBe('outputs/foo-prd.md');
    expect(remapCoworkVirtualPath('/tmp/other.md', cwd)).toBe('/tmp/other.md');
  });

  it('does not treat /workspace-evil as /workspace', () => {
    expect(remapCoworkVirtualPath('/workspace-evil/secret', cwd)).toBe('/workspace-evil/secret');
  });
});

describe('remapCoworkVirtualPathsInCommand', () => {
  const cwd = '/Users/demo/project';

  it('rewrites mkdir targeting /mnt/user-data/outputs', () => {
    expect(remapCoworkVirtualPathsInCommand("mkdir -p '/mnt/user-data/outputs'", cwd)).toBe(
      "mkdir -p '/Users/demo/project/outputs'"
    );
  });

  it('rewrites mkdir targeting /workspace artifact dirs onto the session cwd', () => {
    expect(
      remapCoworkVirtualPathsInCommand('mkdir -p /workspace/york-ie-altitude-artifact', cwd)
    ).toBe('mkdir -p /Users/demo/project/york-ie-altitude-artifact');
  });

  it('rewrites /workspace root and nested paths in a command', () => {
    expect(remapCoworkVirtualPathsInCommand('cd /workspace && ls outputs', cwd)).toBe(
      'cd /Users/demo/project && ls outputs'
    );
    expect(remapCoworkVirtualPathsInCommand('cp skill.tgz /workspace/html2pptx.tgz', cwd)).toBe(
      'cp skill.tgz /Users/demo/project/html2pptx.tgz'
    );
  });

  it('leaves commands without virtual roots unchanged', () => {
    expect(remapCoworkVirtualPathsInCommand('ls outputs', cwd)).toBe('ls outputs');
  });

  it('does not rewrite longer paths that only share a prefix', () => {
    expect(remapCoworkVirtualPathsInCommand('cat /mnt/workspace-evil/secret', cwd)).toBe(
      'cat /mnt/workspace-evil/secret'
    );
    expect(remapCoworkVirtualPathsInCommand('cat /workspace-evil/secret', cwd)).toBe(
      'cat /workspace-evil/secret'
    );
  });

  it('rewrites /mnt/workspace before /workspace so nested mount paths stay correct', () => {
    expect(remapCoworkVirtualPathsInCommand('cat /mnt/workspace/src/index.ts', cwd)).toBe(
      'cat /Users/demo/project/src/index.ts'
    );
  });
});
