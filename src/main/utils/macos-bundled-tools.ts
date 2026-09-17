import { app } from 'electron';
import * as path from 'path';

export type MacToolsArch = 'arm64' | 'x64';

export function macToolsArch(): MacToolsArch {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

/**
 * Directory roots that may contain bundled macOS CLI helpers and .app bundles.
 *
 * Dev layout: `resources/tools/darwin-{arch}/…`
 * Packaged layout (electron-builder extraResources): contents of `darwin-{arch}` are
 * copied to `Contents/Resources/tools/` (no `darwin-{arch}` segment).
 */
export function listMacBundledToolsSearchRoots(projectRootGuesses?: string[]): string[] {
  const arch = macToolsArch();
  const roots: string[] = [];

  try {
    if (app?.isPackaged && process.resourcesPath) {
      const packagedTools = path.join(process.resourcesPath, 'tools');
      roots.push(packagedTools);
      roots.push(path.join(packagedTools, `darwin-${arch}`));
    }
  } catch {
    // app may be unavailable in unit tests
  }

  const guesses =
    projectRootGuesses ??
    [
      path.join(__dirname, '../../../resources/tools'),
      path.join(process.cwd(), 'resources/tools'),
    ];

  for (const root of guesses) {
    roots.push(path.join(root, `darwin-${arch}`));
  }

  const seen = new Set<string>();
  return roots.filter((entry) => {
    const normalized = path.normalize(entry);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}
