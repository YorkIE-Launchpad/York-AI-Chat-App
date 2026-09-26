import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * True for filesystem roots (`/`, `C:\`) that are not safe session workdirs.
 * Electron apps launched from Finder/Dock often have `process.cwd() === '/'`.
 */
export function isUnusableSessionCwd(dir: string): boolean {
  const trimmed = dir.trim();
  if (!trimmed) return true;
  const resolved = path.resolve(trimmed);
  return resolved === path.parse(resolved).root;
}

function defaultIsDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pick the first usable absolute workdir from candidates.
 * Skips relative paths, filesystem roots, and folders that no longer exist
 * (deleted / unmounted) so the agent never runs in a phantom directory.
 * Candidates listed in `creatable` (the app default) are accepted even when
 * missing because callers create them. Falls back to `os.tmpdir()`.
 */
export function resolveWritableSessionCwd(
  candidates: Array<string | null | undefined>,
  options: {
    isDirectory?: (dir: string) => boolean;
    creatable?: Array<string | null | undefined>;
  } = {}
): string {
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const creatable = new Set(
    (options.creatable ?? [])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => path.resolve(value.trim()))
  );
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || !path.isAbsolute(trimmed) || isUnusableSessionCwd(trimmed)) continue;
    const resolved = path.resolve(trimmed);
    if (creatable.has(resolved) || isDirectory(resolved)) {
      return resolved;
    }
  }
  return os.tmpdir();
}
