import { basename, isAbsolute, resolve } from 'node:path';
import * as fs from 'node:fs';
import { isUncPath, isWindowsDrivePath } from '../../shared/local-file-path';
import {
  extractOutputsRelativePath,
  resolvePathAgainstWorkspace,
} from '../../shared/workspace-path';
import { isPathWithinRoot } from '../tools/path-containment';
import { buildRevealSearchRoots, findFileByNameInRoots } from './find-workspace-file';

export type ResolveWorkspaceLocalPathResult =
  | { path: string; baseDir: string }
  | { error: string };

export interface ResolveWorkspaceLocalPathOptions {
  preferredBaseDir?: string;
  defaultWorkingDir: string;
  userDataDefaultWorkingDir: string;
  existsSync?: (filePath: string) => boolean;
  caseInsensitive?: boolean;
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

  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
  const searchRoots = buildRevealSearchRoots({
    cwd: options.preferredBaseDir,
    defaultWorkingDir,
    userDataDefaultWorkingDir,
  });
  if (searchRoots.length === 0) {
    searchRoots.push(resolve(baseDir));
  }

  const isAllowed = (candidate: string): boolean =>
    searchRoots.some((root) => isPathWithinRoot(candidate, root, caseInsensitive));

  const toAbsolute = (value: string, root: string, remapOutsideOutputs: boolean): string => {
    let normalized = resolvePathAgainstWorkspace(value.trim(), root, { remapOutsideOutputs });
    if (
      !isAbsolute(normalized) &&
      !isWindowsDrivePath(normalized) &&
      !isUncPath(normalized)
    ) {
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
    addCandidate(toAbsolute(filePath, root, true));
    addCandidate(toAbsolute(filePath, root, false));
  }

  const isExistingOutputsDump = (candidate: string): boolean => {
    if (!extractOutputsRelativePath(filePath)) {
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

  const discovered = findFileByNameInRoots(basename(toAbsolute(filePath, baseDir, true)), searchRoots);
  if (discovered && exists(discovered) && isAllowed(discovered)) {
    return { path: discovered, baseDir };
  }

  const remapped = toAbsolute(filePath, baseDir, true);
  if (isAllowed(remapped)) {
    return { error: `ENOENT: no such file or directory, stat '${remapped}'` };
  }

  return { error: 'Path outside workspace' };
}
