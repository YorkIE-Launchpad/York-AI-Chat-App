import { basename, isAbsolute, join, resolve } from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { isUncPath, isWindowsDrivePath } from '../../shared/local-file-path';
import {
  extractOutputsRelativePath,
  resolvePathAgainstWorkspace,
} from '../../shared/workspace-path';
import { isPathWithinRoot } from '../tools/path-containment';
import { buildRevealSearchRoots, findFileByNameInRoots } from './find-workspace-file';

export type ResolveWorkspaceLocalPathResult =
  | { path: string; baseDir: string; outsideWorkspace?: boolean }
  | { error: string };

export const PATH_OUTSIDE_WORKSPACE_ERROR = 'Path outside workspace';

export interface ResolveWorkspaceLocalPathOptions {
  preferredBaseDir?: string;
  defaultWorkingDir: string;
  userDataDefaultWorkingDir: string;
  /**
   * App-managed folders the agent legitimately writes to (skills, plugins).
   * Files under these roots are accepted but never searched by basename.
   */
  extraRoots?: Array<string | null | undefined>;
  /** Accept an existing absolute file outside every root (flagged `outsideWorkspace`). */
  allowOutsideRoots?: boolean;
  existsSync?: (filePath: string) => boolean;
  caseInsensitive?: boolean;
  homeDir?: string;
  /** Return an in-workspace path even when the file is not on disk yet. */
  allowMissing?: boolean;
}

export function expandHomePath(value: string, homeDir: string = os.homedir()): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

/**
 * Resolve a user/agent path into an absolute path that can be previewed or
 * opened. Remaps virtual Cowork roots and `.../outputs/...` guesses onto the
 * workspace, but prefers a path that actually exists — including the original
 * absolute file when the agent wrote outside cwd (e.g. ~/outputs).
 */
export function resolveWorkspaceLocalPath(
  filePath: string,
  options: ResolveWorkspaceLocalPathOptions
): ResolveWorkspaceLocalPathResult {
  const exists = options.existsSync ?? ((candidate: string) => fs.existsSync(candidate));
  const defaultWorkingDir = options.defaultWorkingDir || '';
  const userDataDefaultWorkingDir = options.userDataDefaultWorkingDir || '';
  const baseDir =
    options.preferredBaseDir && isAbsolute(options.preferredBaseDir)
      ? options.preferredBaseDir
      : defaultWorkingDir || userDataDefaultWorkingDir || '';

  if (!baseDir) {
    return { error: 'No workspace directory' };
  }

  const input = expandHomePath(filePath.trim(), options.homeDir);
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
  const searchRoots = buildRevealSearchRoots({
    cwd: options.preferredBaseDir,
    defaultWorkingDir,
    userDataDefaultWorkingDir,
  });
  if (searchRoots.length === 0) {
    searchRoots.push(resolve(baseDir));
  }
  const allowedRoots = [...searchRoots];
  for (const root of options.extraRoots ?? []) {
    if (!root?.trim() || !isAbsolute(root.trim())) continue;
    const resolvedRoot = resolve(root.trim());
    if (!allowedRoots.includes(resolvedRoot)) allowedRoots.push(resolvedRoot);
  }

  const isAllowed = (candidate: string): boolean =>
    allowedRoots.some((root) => isPathWithinRoot(candidate, root, caseInsensitive));

  const toAbsolute = (value: string, root: string, remapOutsideOutputs: boolean): string => {
    let normalized = resolvePathAgainstWorkspace(value, root, { remapOutsideOutputs });
    if (!isAbsolute(normalized) && !isWindowsDrivePath(normalized) && !isUncPath(normalized)) {
      normalized = resolve(root, normalized);
    }
    if (!isUncPath(normalized)) {
      normalized = resolve(normalized);
    }
    return normalized;
  };

  const candidates: string[] = [];
  const addCandidate = (candidate: string) => {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  for (const root of [baseDir, ...searchRoots]) {
    addCandidate(toAbsolute(input, root, true));
    addCandidate(toAbsolute(input, root, false));
  }

  const isExistingOutputsDump = (candidate: string): boolean => {
    if (!extractOutputsRelativePath(input)) {
      return false;
    }
    return exists(candidate);
  };

  for (const candidate of candidates) {
    if (!exists(candidate)) {
      continue;
    }
    if (isAllowed(candidate) || isExistingOutputsDump(candidate)) {
      return { path: candidate, baseDir };
    }
  }

  const inputIsAbsolute = isAbsolute(input) || isWindowsDrivePath(input) || isUncPath(input);
  const literalAbsolute = inputIsAbsolute ? toAbsolute(input, baseDir, false) : '';
  if (literalAbsolute && exists(literalAbsolute) && options.allowOutsideRoots) {
    return { path: literalAbsolute, baseDir, outsideWorkspace: true };
  }

  const discovered = findFileByNameInRoots(basename(toAbsolute(input, baseDir, true)), searchRoots);
  if (discovered && exists(discovered) && isAllowed(discovered)) {
    return { path: discovered, baseDir };
  }

  const remapped = toAbsolute(input, baseDir, true);
  if (isAllowed(remapped)) {
    if (options.allowMissing) {
      return { path: remapped, baseDir };
    }
    return { error: `ENOENT: no such file or directory, stat '${remapped}'` };
  }

  if (literalAbsolute && !exists(literalAbsolute)) {
    return { error: `ENOENT: no such file or directory, stat '${literalAbsolute}'` };
  }

  return { error: PATH_OUTSIDE_WORKSPACE_ERROR };
}
