import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkspaceLocalPath } from '../src/main/utils/resolve-workspace-local-path';

describe('resolveWorkspaceLocalPath', () => {
  let tempRoot: string;
  let workspace: string;
  let homeOutputs: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'york-local-path-'));
    workspace = path.join(tempRoot, 'default_working_dir');
    homeOutputs = path.join(tempRoot, 'Users', 'kalravparsana', 'outputs');
    fs.mkdirSync(path.join(workspace, 'outputs'), { recursive: true });
    fs.mkdirSync(homeOutputs, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('opens an existing home outputs file instead of a missing remapped workspace copy', () => {
    const realFile = path.join(homeOutputs, 'sarkhej-police-letter.html');
    fs.writeFileSync(realFile, '<html></html>');

    const resolved = resolveWorkspaceLocalPath(
      path.join(homeOutputs, 'sarkhej-police-letter.html'),
      {
        preferredBaseDir: workspace,
        defaultWorkingDir: workspace,
        userDataDefaultWorkingDir: workspace,
      }
    );

    expect(resolved).toEqual({ path: realFile, baseDir: workspace });
  });

  it('prefers the workspace copy when the agent path was invented but the file is in cwd', () => {
    const workspaceFile = path.join(workspace, 'outputs', 'sarkhej-police-letter.html');
    fs.writeFileSync(workspaceFile, '<html>workspace</html>');

    const resolved = resolveWorkspaceLocalPath(
      '/Users/someone/outputs/sarkhej-police-letter.html',
      {
        preferredBaseDir: workspace,
        defaultWorkingDir: workspace,
        userDataDefaultWorkingDir: workspace,
      }
    );

    expect(resolved).toEqual({ path: workspaceFile, baseDir: workspace });
  });

  it('returns ENOENT when neither the remapped nor original file exists', () => {
    const requested = '/Users/someone/outputs/missing.html';
    const resolved = resolveWorkspaceLocalPath(requested, {
      preferredBaseDir: workspace,
      defaultWorkingDir: workspace,
      userDataDefaultWorkingDir: workspace,
    });

    expect(resolved).toEqual({
      error: `ENOENT: no such file or directory, stat '${path.join(workspace, 'outputs', 'missing.html')}'`,
    });
  });
});
