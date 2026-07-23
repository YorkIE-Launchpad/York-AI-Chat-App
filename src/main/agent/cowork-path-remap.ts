import * as path from 'path';

/**
 * Claude Cowork / Desktop skills often hardcode virtual roots like
 * `/mnt/user-data/outputs`. York IE maps the session workspace to the real
 * project folder instead — remap those roots so writes land in the same cwd.
 */
export const COWORK_VIRTUAL_ROOTS = ['/mnt/user-data', '/mnt/workspace'] as const;

export function remapCoworkVirtualPath(inputPath: string, workspaceRoot: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed || !workspaceRoot) {
    return inputPath;
  }

  for (const root of COWORK_VIRTUAL_ROOTS) {
    if (trimmed === root || trimmed.startsWith(`${root}/`)) {
      const relative = trimmed.slice(root.length).replace(/^\//, '');
      return relative ? path.join(workspaceRoot, relative) : workspaceRoot;
    }
  }

  return inputPath;
}

/**
 * Rewrite Cowork virtual roots inside a bash command string.
 * Only replaces a root when it is a full path segment (end, `/`, or
 * non-path boundary) so `/mnt/workspace-evil` is left alone.
 */
export function remapCoworkVirtualPathsInCommand(command: string, workspaceRoot: string): string {
  if (!command || !workspaceRoot) {
    return command;
  }

  let rewritten = command;
  for (const root of COWORK_VIRTUAL_ROOTS) {
    const pattern = new RegExp(`${escapeRegExp(root)}(?=$|[/\\s'"\`])`, 'g');
    rewritten = rewritten.replace(pattern, workspaceRoot);
  }
  return rewritten;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
