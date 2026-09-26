import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PATH_OUTSIDE_WORKSPACE_ERROR,
  resolveWorkspaceLocalPath,
} from '../../main/utils/resolve-workspace-local-path';
import { resolveWritableSessionCwd } from '../../main/session/resolve-session-cwd';
import { looksLikeWebDomain, splitTextByFileMentions } from '../../renderer/utils/file-link';
import { buildSessionFileIndex, lookupSessionFile } from '../../renderer/utils/session-file-index';
import type { TraceStep } from '../../renderer/types';

function makeTempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-paths-'));
  const workspace = path.join(root, 'workspace');
  const skills = path.join(root, 'userData', 'claude', 'skills', 'demo');
  const outside = path.join(root, 'Desktop');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(skills, 'SKILL.md'), '# skill');
  fs.writeFileSync(path.join(outside, 'report.md'), '# report');
  return { root, workspace, skillsRoot: path.join(root, 'userData', 'claude'), skills, outside };
}

describe('resolveWorkspaceLocalPath', () => {
  it('accepts files under app-managed extra roots', () => {
    const t = makeTempTree();
    const target = path.join(t.skills, 'SKILL.md');
    const result = resolveWorkspaceLocalPath(target, {
      preferredBaseDir: t.workspace,
      defaultWorkingDir: t.workspace,
      userDataDefaultWorkingDir: t.workspace,
      extraRoots: [t.skillsRoot],
    });
    expect(result).toEqual({ path: target, baseDir: t.workspace });
  });

  it('rejects existing outside files unless allowOutsideRoots is set', () => {
    const t = makeTempTree();
    const target = path.join(t.outside, 'report.md');
    const base = {
      preferredBaseDir: t.workspace,
      defaultWorkingDir: t.workspace,
      userDataDefaultWorkingDir: t.workspace,
    };
    expect(resolveWorkspaceLocalPath(target, base)).toEqual({
      error: PATH_OUTSIDE_WORKSPACE_ERROR,
    });
    expect(resolveWorkspaceLocalPath(target, { ...base, allowOutsideRoots: true })).toEqual({
      path: target,
      baseDir: t.workspace,
      outsideWorkspace: true,
    });
  });

  it('reports missing absolute files as ENOENT, not "outside workspace"', () => {
    const t = makeTempTree();
    const missing = path.join(t.outside, 'not-written-yet.md');
    const result = resolveWorkspaceLocalPath(missing, {
      preferredBaseDir: t.workspace,
      defaultWorkingDir: t.workspace,
      userDataDefaultWorkingDir: t.workspace,
      allowOutsideRoots: true,
    });
    expect('error' in result && result.error).toMatch(/ENOENT/);
  });

  it('expands ~/ against the home directory', () => {
    const t = makeTempTree();
    const result = resolveWorkspaceLocalPath('~/Desktop/report.md', {
      preferredBaseDir: t.workspace,
      defaultWorkingDir: t.workspace,
      userDataDefaultWorkingDir: t.workspace,
      allowOutsideRoots: true,
      homeDir: t.root,
    });
    expect(result).toMatchObject({ path: path.join(t.outside, 'report.md') });
  });
});

describe('resolveWritableSessionCwd', () => {
  it('skips deleted folders and relative paths', () => {
    const t = makeTempTree();
    const gone = path.join(t.root, 'deleted-folder');
    expect(resolveWritableSessionCwd(['relative/dir', gone, t.workspace])).toBe(t.workspace);
  });

  it('accepts a creatable default even when missing', () => {
    const t = makeTempTree();
    const fresh = path.join(t.root, 'default_working_dir');
    expect(resolveWritableSessionCwd([null, fresh], { creatable: [fresh] })).toBe(fresh);
  });

  it('never returns the filesystem root', () => {
    expect(resolveWritableSessionCwd(['/'])).toBe(os.tmpdir());
  });
});

describe('splitTextByFileMentions', () => {
  const files = (text: string) =>
    splitTextByFileMentions(text)
      .filter((part) => part.type === 'file')
      .map((part) => part.value);

  it('keeps dotted folders inside absolute paths', () => {
    expect(files('Saved to /Users/me/.claude/skills/demo/SKILL.md now')).toEqual([
      '/Users/me/.claude/skills/demo/SKILL.md',
    ]);
  });

  it('handles paths with spaces and ~/', () => {
    expect(
      files('See /Users/me/Library/Application Support/york-ie/notes.md and ~/Desktop/a.html.')
    ).toEqual(['/Users/me/Library/Application Support/york-ie/notes.md', '~/Desktop/a.html']);
  });

  it('does not treat domains or framework names as files', () => {
    expect(files('Visit hdfcergo.com or www.example.io, built with Node.js')).toEqual([]);
    expect(files('Open SKILL.md and report.pdf')).toEqual(['SKILL.md', 'report.pdf']);
  });

  it('ignores paths inside URLs', () => {
    expect(files('https://example.com/docs/page.html')).toEqual([]);
  });
});

describe('looksLikeWebDomain', () => {
  it('distinguishes hosts from filenames', () => {
    expect(looksLikeWebDomain('hdfcergo.com')).toBe(true);
    expect(looksLikeWebDomain('docs.example.org/path')).toBe(true);
    expect(looksLikeWebDomain('README.md')).toBe(false);
    expect(looksLikeWebDomain('script.py')).toBe(false);
  });
});

describe('session file index', () => {
  const step = (toolName: string, filePath: string, extra: Partial<TraceStep> = {}): TraceStep => ({
    id: `${toolName}-${filePath}`,
    type: 'tool_call',
    status: 'completed',
    title: toolName,
    toolName,
    toolInput: { path: filePath },
    timestamp: Date.now(),
    ...extra,
  });

  it('resolves bare names and relative fragments to files the agent touched', () => {
    const skill = '/Users/me/Library/Application Support/york-ie/claude/skills/demo/SKILL.md';
    const ref = '/Users/me/Library/Application Support/york-ie/claude/skills/demo/references/01.md';
    const index = buildSessionFileIndex(
      [
        step('write', skill),
        step('write', ref),
        step('write', '/tmp/failed.md', { isError: true }),
      ],
      '/Users/me/workspace'
    );
    expect(lookupSessionFile(index, 'SKILL.md')).toBe(skill);
    expect(lookupSessionFile(index, 'references/01.md')).toBe(ref);
    expect(lookupSessionFile(index, 'failed.md')).toBeNull();
    expect(lookupSessionFile(index, 'file:///x/SKILL.md')).toBeNull();
  });

  it('resolves relative tool paths against the chat cwd', () => {
    const index = buildSessionFileIndex([step('write', 'outputs/deck.html')], '/Users/me/ws');
    expect(lookupSessionFile(index, 'deck.html')).toBe('/Users/me/ws/outputs/deck.html');
  });
});
