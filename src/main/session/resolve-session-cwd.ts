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

/**
 * Pick the first usable absolute workdir from candidates.
 * Falls back to `os.tmpdir()` so attachment staging never targets `/.tmp`.
 */
export function resolveWritableSessionCwd(
  candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || isUnusableSessionCwd(trimmed)) continue;
    return path.resolve(trimmed);
  }
  return os.tmpdir();
}
