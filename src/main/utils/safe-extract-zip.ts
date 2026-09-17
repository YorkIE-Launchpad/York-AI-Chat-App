/**
 * Safe ZIP extraction — rejects symlinks, path traversal, and absolute entry paths
 * before extract-zip writes any bytes (defense against Zip Slip / symlink overwrite).
 */
import * as fs from 'fs';
import * as path from 'path';
import extract from 'extract-zip';
import { isPathWithinRoot } from '../tools/path-containment';

/** Unix S_IFLNK in the upper 16 bits of externalFileAttributes. */
const UNIX_S_IFLNK = 0o120000;
const UNIX_S_IFMT = 0o170000;

function isSymlinkEntry(externalFileAttributes: number): boolean {
  const mode = (externalFileAttributes >>> 16) & 0xffff;
  return (mode & UNIX_S_IFMT) === UNIX_S_IFLNK;
}

function assertSafeEntryName(fileName: string, destRoot: string): string {
  if (!fileName || fileName.includes('\0')) {
    throw new Error(`Unsafe zip entry rejected: ${fileName || '(empty)'}`);
  }

  const normalized = fileName.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Zip entry with absolute path rejected: ${fileName}`);
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Zip entry with path traversal rejected: ${fileName}`);
  }

  const target = path.resolve(destRoot, normalized);
  if (target !== destRoot && !isPathWithinRoot(target, destRoot)) {
    throw new Error(`Zip entry escapes extract directory: ${fileName}`);
  }

  return target;
}

/**
 * Extract a ZIP into destDir, refusing symlink entries and path escapes.
 * Callers should still treat post-extract contents as untrusted input.
 */
export async function safeExtractZip(zipPath: string, destDir: string): Promise<void> {
  const resolvedDest = path.resolve(destDir);
  await fs.promises.mkdir(resolvedDest, { recursive: true });

  await extract(zipPath, {
    dir: resolvedDest,
    onEntry: (entry) => {
      assertSafeEntryName(entry.fileName, resolvedDest);
      if (isSymlinkEntry(entry.externalFileAttributes)) {
        throw new Error(`Zip symlink entries are not allowed: ${entry.fileName}`);
      }
    },
  });

  // Defense in depth: refuse if anything under dest is a symlink after extract.
  await assertNoSymlinksUnder(resolvedDest);
}

async function assertNoSymlinksUnder(root: string): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlink detected after zip extract: ${full}`);
      }
      if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
}
