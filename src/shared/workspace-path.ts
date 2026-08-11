import { isUncPath, isWindowsDrivePath } from './local-file-path';

/**
 * Virtual roots mapped onto the session workspace.
 * Longer/more specific roots first so bash rewrites do not treat the
 * `/workspace` suffix inside `/mnt/workspace` as a standalone root.
 */
export const COWORK_VIRTUAL_ROOTS = ['/mnt/user-data', '/mnt/workspace', '/workspace'] as const;

function remapCoworkAbsolutePath(pathValue: string, workspacePath?: string | null): string | null {
  if (!workspacePath) {
    return null;
  }

  for (const root of COWORK_VIRTUAL_ROOTS) {
    if (pathValue === root) {
      return workspacePath;
    }
    if (pathValue.startsWith(`${root}/`)) {
      return joinRelativePath(workspacePath, pathValue.slice(root.length + 1));
    }
  }

  return null;
}

/**
 * Agents sometimes emit absolute paths like `/Users/someone/outputs/deck.html`
 * that fall outside the open workspace even though the real file was written
 * under `workspace/outputs/...`. Reclaim those as workspace-relative
 * `outputs/...` paths.
 *
 * Rejects `..` segments so remapping cannot escape the workspace.
 */
export function extractOutputsRelativePath(pathValue: string): string | null {
  if (!pathValue?.trim()) {
    return null;
  }

  const normalized = pathValue.trim().replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)outputs\/(.+)$/i);
  if (!match?.[1]) {
    return null;
  }

  const segments = match[1].split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    return null;
  }

  return `outputs/${segments.join('/')}`;
}

function pathLooksUnderRoot(candidate: string, root: string): boolean {
  const toComparable = (value: string): string => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    // Windows drive / UNC compare case-insensitively; POSIX keeps case.
    if (isWindowsDrivePath(value) || isUncPath(value)) {
      return normalized.toLowerCase();
    }
    return normalized;
  };

  const candidateNorm = toComparable(candidate);
  const rootNorm = toComparable(root);
  if (!candidateNorm || !rootNorm) {
    return false;
  }
  return candidateNorm === rootNorm || candidateNorm.startsWith(`${rootNorm}/`);
}

function remapOutsideOutputsAbsolutePath(
  pathValue: string,
  workspacePath?: string | null
): string | null {
  if (!workspacePath) {
    return null;
  }
  if (pathLooksUnderRoot(pathValue, workspacePath)) {
    return null;
  }
  const outputsRelative = extractOutputsRelativePath(pathValue);
  if (!outputsRelative) {
    return null;
  }
  return joinRelativePath(workspacePath, outputsRelative);
}

export function resolvePathAgainstWorkspace(
  pathValue: string,
  workspacePath?: string | null
): string {
  if (!pathValue) {
    return pathValue;
  }

  if (isWindowsDrivePath(pathValue) || isUncPath(pathValue) || pathValue.startsWith('/')) {
    const coworkRemapped = remapCoworkAbsolutePath(pathValue, workspacePath);
    if (coworkRemapped !== null) {
      return coworkRemapped;
    }
    if (/^[A-Za-z]:[/\\]workspace[/\\]/i.test(pathValue)) {
      const relativePart = pathValue.replace(/^[A-Za-z]:[/\\]workspace[/\\]/i, '');
      return workspacePath ? joinRelativePath(workspacePath, relativePart) : pathValue;
    }
    const outputsRemapped = remapOutsideOutputsAbsolutePath(pathValue, workspacePath);
    if (outputsRemapped !== null) {
      return outputsRemapped;
    }
    return pathValue;
  }

  if (!workspacePath) {
    return pathValue;
  }

  return joinRelativePath(workspacePath, pathValue);
}

/**
 * Join base + relative path without Node.js `path` module (browser-safe).
 * Handles `.` and `..` segment normalization.
 */
function joinRelativePath(basePath: string, relativePath: string): string {
  const isWin = isWindowsDrivePath(basePath) || isUncPath(basePath);
  const sep = isWin ? '\\' : '/';

  const base = basePath.replace(/[/\\]+$/, '');
  const rel = relativePath.replace(/^[/\\]+/, '');
  const joined = `${base}${sep}${rel}`;

  // Normalize separators then resolve `.` / `..` segments
  const normalized = joined.replace(/[/\\]+/g, sep);
  const parts = normalized.split(sep);
  const resolved: string[] = [];

  // Determine the minimum number of parts that must remain to prevent
  // traversal above the path root:
  //   - UNC path  \\server\share  → splits to ['', '', 'server', 'share', …]
  //                                  floor = 4 (keep both empty + server + share)
  //   - Windows drive  C:\         → splits to ['C:', …]
  //                                  floor = 1
  //   - POSIX absolute /           → splits to ['', …]
  //                                  floor = 1
  const floor = isUncPath(basePath) ? 4 : 1;

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..' && resolved.length > floor) {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  const result = resolved.join(sep);

  // Post-resolve prefix check: ensure the path root prefix is preserved.
  // For POSIX paths the root is '/', for Windows drives it's 'X:', for UNC it's '\\\\server\\share'.
  const rootPrefix = isUncPath(basePath)
    ? parts.slice(0, 4).join(sep)
    : isWindowsDrivePath(basePath)
      ? parts[0] // e.g. 'C:'
      : ''; // POSIX: empty string is a valid prefix check; resolved always starts with '/'
  if (rootPrefix && !result.startsWith(rootPrefix)) {
    // Root prefix was stripped — traversal escaped the filesystem root; clamp to base
    return base;
  }

  return result;
}
