import { describe, expect, it } from 'vitest';
import {
  remapCoworkVirtualPath,
  remapCoworkVirtualPathsInCommand,
} from '../src/main/agent/cowork-path-remap';

describe('remapCoworkVirtualPath', () => {
  const cwd = '/Users/demo/project';

  it('maps /mnt/user-data outputs into the workspace', () => {
    expect(remapCoworkVirtualPath('/mnt/user-data/outputs/foo-prd.md', cwd)).toBe(
      '/Users/demo/project/outputs/foo-prd.md'
    );
  });

  it('maps /mnt/workspace paths into the workspace', () => {
    expect(remapCoworkVirtualPath('/mnt/workspace/src/index.ts', cwd)).toBe(
      '/Users/demo/project/src/index.ts'
    );
  });

  it('maps the virtual root itself to the workspace root', () => {
    expect(remapCoworkVirtualPath('/mnt/user-data', cwd)).toBe(cwd);
    expect(remapCoworkVirtualPath('/mnt/workspace', cwd)).toBe(cwd);
  });

  it('leaves relative and unrelated absolute paths unchanged', () => {
    expect(remapCoworkVirtualPath('outputs/foo-prd.md', cwd)).toBe('outputs/foo-prd.md');
    expect(remapCoworkVirtualPath('/tmp/other.md', cwd)).toBe('/tmp/other.md');
  });
});

describe('remapCoworkVirtualPathsInCommand', () => {
  const cwd = '/Users/demo/project';

  it('rewrites mkdir targeting /mnt/user-data/outputs', () => {
    expect(remapCoworkVirtualPathsInCommand("mkdir -p '/mnt/user-data/outputs'", cwd)).toBe(
      "mkdir -p '/Users/demo/project/outputs'"
    );
  });

  it('leaves commands without virtual roots unchanged', () => {
    expect(remapCoworkVirtualPathsInCommand('ls outputs', cwd)).toBe('ls outputs');
  });

  it('does not rewrite longer paths that only share a prefix', () => {
    expect(remapCoworkVirtualPathsInCommand('cat /mnt/workspace-evil/secret', cwd)).toBe(
      'cat /mnt/workspace-evil/secret'
    );
  });
});
