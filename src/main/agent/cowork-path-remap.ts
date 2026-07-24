import { COWORK_VIRTUAL_ROOTS } from '../../shared/workspace-path';

/**
 * Claude Cowork / Desktop skills often hardcode virtual roots like
 * `/mnt/user-data/outputs`. York IE maps those onto the session workspace.
 * Returns a workspace-relative path so tool output and artifact UI stay aligned.
 */
export function remapCoworkVirtualPath(inputPath: string, workspaceRoot: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed || !workspaceRoot) {
    return inputPath;
  }

  for (const root of COWORK_VIRTUAL_ROOTS) {
    if (trimmed === root) {
      return '.';
    }
    if (trimmed.startsWith(`${root}/`)) {
      return trimmed.slice(root.length + 1);
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
