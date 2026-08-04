import fs from 'node:fs';
import path from 'node:path';

/**
 * Build a compact top-level listing of a workspace directory for agent context.
 * Helps the model ground file tools in what actually exists without an extra ls call.
 */
export function buildWorkspaceTopLevelListing(
  workspacePath: string,
  options?: { maxEntries?: number }
): string {
  const maxEntries = options?.maxEntries ?? 40;
  const resolved = path.resolve(workspacePath);

  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return '(workspace path missing or not a directory)';
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const names = entries
      .filter((entry) => {
        if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') return false;
        // Skip macOS resource-fork sidecars
        if (entry.name.startsWith('._')) return false;
        return true;
      })
      .map((entry) => {
        const suffix = entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : '';
        return `${entry.name}${suffix}`;
      })
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    if (names.length === 0) {
      return '(empty directory)';
    }

    if (names.length <= maxEntries) {
      return names.join('\n');
    }

    const shown = names.slice(0, maxEntries);
    const remaining = names.length - maxEntries;
    return `${shown.join('\n')}\n… and ${remaining} more`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `(unable to list workspace: ${message})`;
  }
}
