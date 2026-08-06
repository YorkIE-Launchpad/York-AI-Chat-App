import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.cowork-user-data',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  '.yarn',
  '.pnpm-store',
]);

/**
 * Search roots for a basename, preferring deeper / newer matches.
 * Skips huge dependency directories. Returns the newest match by mtime.
 */
export function findFileByNameInRoots(
  fileName: string,
  roots: Array<string | null | undefined>,
  options?: { maxDirs?: number }
): string | null {
  const name = fileName?.trim();
  if (!name || name === '.' || name === '..') {
    return null;
  }

  // Ignore absolute path fragments accidentally passed as "filename"
  if (name.includes('/') || name.includes('\\')) {
    return null;
  }

  const maxDirs = options?.maxDirs ?? 2500;
  let best: { path: string; mtime: number } | null = null;
  let scannedDirs = 0;
  const visited = new Set<string>();

  const queue = roots
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map((root) => resolve(root.trim()))
    .filter((root) => {
      try {
        return fs.existsSync(root) && fs.statSync(root).isDirectory();
      } catch {
        return false;
      }
    });

  // Prefer scanning outputs/ first by enqueuing them ahead of each root
  const preferred: string[] = [];
  for (const root of queue) {
    const outputs = join(root, 'outputs');
    try {
      if (fs.existsSync(outputs) && fs.statSync(outputs).isDirectory()) {
        preferred.push(outputs);
      }
    } catch {
      // ignore
    }
  }
  const scanQueue = [...preferred, ...queue];

  while (scanQueue.length > 0 && scannedDirs < maxDirs) {
    const dir = scanQueue.shift()!;
    if (visited.has(dir)) continue;
    visited.add(dir);
    scannedDirs += 1;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== name) {
        // still allow exact-dotfile matches when requested
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) {
            // skip hidden dirs
            continue;
          }
        }
      }

      const fullPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isFile() && entry.name === name) {
        let mtime = 0;
        try {
          mtime = fs.statSync(fullPath).mtimeMs;
        } catch {
          mtime = 0;
        }
        if (!best || mtime >= best.mtime) {
          best = { path: fullPath, mtime };
        }
        continue;
      }

      if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
        // don't descend into heavy hidden dirs except we already skip most with startsWith.
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        scanQueue.push(fullPath);
      }
    }
  }

  return best?.path ?? null;
}

/**
 * True when the path input only specifies a bare filename (no directory components).
 * Used to avoid opening an empty workspace root when a loose filename cannot be found.
 */
export function isBareFilenameReference(pathValue: string): boolean {
  const trimmed = pathValue.trim();
  if (!trimmed) return false;
  const stripped = trimmed.replace(/^file:\/\//i, '');
  if (stripped.includes('/') || stripped.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(stripped)) return false;
  return basename(stripped) === stripped;
}

/**
 * Whether opening the parent folder is a reasonable fallback when the file is missing.
 * Bare names that only resolved into a workspace root should not open that empty root.
 */
export function shouldOpenMissingFileParent(options: {
  originalPath: string;
  resolvedPath: string;
  parentDir: string;
  workspaceRoots: Array<string | null | undefined>;
}): boolean {
  if (!options.parentDir) return false;
  if (isBareFilenameReference(options.originalPath)) {
    return false;
  }
  const parent = resolve(options.parentDir);
  // Don't dump users into workspace root as a "reveal" when the file was missing
  for (const root of options.workspaceRoots) {
    if (!root) continue;
    try {
      if (resolve(root) === parent) {
        return false;
      }
    } catch {
      // ignore
    }
  }
  // Only open parent if it's a real directory with something more specific than root
  try {
    return fs.existsSync(parent) && fs.statSync(parent).isDirectory();
  } catch {
    return false;
  }
}

export function buildRevealSearchRoots(options: {
  cwd?: string | null;
  defaultWorkingDir?: string | null;
  userDataDefaultWorkingDir?: string | null;
}): string[] {
  const roots: string[] = [];
  const add = (value?: string | null) => {
    if (!value?.trim()) return;
    const resolved = resolve(value.trim());
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  add(options.cwd);
  add(options.defaultWorkingDir);
  add(options.userDataDefaultWorkingDir);
  return roots;
}

/** @internal exported for tests */
export function dirnameForReveal(filePath: string): string {
  return dirname(filePath);
}
