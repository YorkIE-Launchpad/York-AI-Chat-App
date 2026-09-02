/**
 * Soft-scope LaunchPad MCP tools to the session's locked LaunchPad project id(s).
 * Complements Hub hard-scope in project-mcp-scope.ts.
 */

import {
  normalizeSessionDivision,
  resolveProjectAllowlist,
  type SessionDivisionFields,
} from './workspace-division';

const LAUNCHPAD_MCP_PREFIXES = [
  'mcp__r_d_launchpad__',
  'mcp__launchpad__',
  'mcp__r_d_launchpad',
] as const;

/** Tools that take a LaunchPad numeric project id. */
const LP_PROJECT_ID_TOOLS = new Set([
  'get_project',
  'get_project_settings',
  'update_project',
  'list_features',
  'list_bugs',
  'list_releases',
  'get_release',
  'start_scope_implement',
  'start_preview',
  'get_implement_status',
  'get_preview_status',
  'seed_release_from_prior',
  'list_project_names',
]);

const LP_PROJECT_ID_ARG_KEYS = ['projectId', 'project_id', 'id'] as const;

export type LaunchpadScopedMcpPrepare =
  | { kind: 'allow'; args: Record<string, unknown> }
  | { kind: 'block'; message: string; attemptedProjectId?: string };

export function isLaunchpadMcpToolName(toolName: string): boolean {
  const lowered = toolName.toLowerCase();
  return (
    lowered.startsWith('mcp__r_d_launchpad__') ||
    lowered.startsWith('mcp__launchpad__') ||
    (lowered.startsWith('mcp__') && lowered.includes('launchpad'))
  );
}

export function launchpadMcpOriginalToolName(toolName: string): string | null {
  if (!isLaunchpadMcpToolName(toolName)) {
    return null;
  }
  const parts = toolName.split('__');
  if (parts.length < 3) {
    return null;
  }
  return parts.slice(2).join('__').toLowerCase();
}

function readLpProjectIdArg(args: Record<string, unknown>): number | null {
  for (const key of LP_PROJECT_ID_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function injectLpProjectIdArg(
  args: Record<string, unknown>,
  launchpadProjectId: number
): Record<string, unknown> {
  const next = { ...args };
  for (const key of LP_PROJECT_ID_ARG_KEYS) {
    if (key in next) {
      next[key] = launchpadProjectId;
      return next;
    }
  }
  next.projectId = launchpadProjectId;
  return next;
}

export function launchpadScopeRefuseMessage(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'client' && normalized.clientName) {
    return [
      'Incorrect use. This attempt will be reported.',
      `This session is scoped to client "${normalized.clientName}" and its LaunchPad projects only.`,
      'Switch Client or Project workspace in the sidebar to work on another project.',
    ].join(' ');
  }
  const name =
    normalized.launchpadProjectName ||
    normalized.hubProjectName ||
    (normalized.launchpadProjectId != null
      ? `LP ${normalized.launchpadProjectId}`
      : 'this project');
  return [
    'Incorrect use. This attempt will be reported.',
    `This session is scoped to LaunchPad project "${name}"` +
      (normalized.launchpadProjectId != null
        ? ` (launchpad project id: ${normalized.launchpadProjectId})`
        : '') +
      '.',
    'Switch Project workspace in the sidebar to work on another project.',
  ].join(' ');
}

/**
 * Soft-inject LaunchPad project id on LP MCP tools for project/client division sessions.
 * No-ops when session has no launchpad project id(s).
 */
export function prepareLaunchpadScopedMcpArgs(
  toolName: string,
  args: Record<string, unknown>,
  session: Partial<SessionDivisionFields> | null | undefined
): LaunchpadScopedMcpPrepare {
  const normalized = normalizeSessionDivision(session);
  const allowlist = resolveProjectAllowlist(session);
  if (!allowlist || allowlist.launchpadIds.size === 0) {
    return { kind: 'allow', args };
  }

  const original = launchpadMcpOriginalToolName(toolName);
  if (!original) {
    return { kind: 'allow', args };
  }

  const isClientDivision = normalized.division === 'client';
  const singleLocked =
    !isClientDivision &&
    normalized.launchpadProjectId != null &&
    Number.isFinite(normalized.launchpadProjectId)
      ? normalized.launchpadProjectId
      : null;

  const provided = readLpProjectIdArg(args);
  const looksScoped =
    LP_PROJECT_ID_TOOLS.has(original) || provided != null || original.includes('project');

  if (!looksScoped) {
    return { kind: 'allow', args };
  }

  if (provided != null && !allowlist.launchpadIds.has(provided)) {
    return {
      kind: 'block',
      message: launchpadScopeRefuseMessage(session),
      attemptedProjectId: String(provided),
    };
  }

  if (isClientDivision) {
    return { kind: 'allow', args };
  }

  if (singleLocked != null) {
    return {
      kind: 'allow',
      args: injectLpProjectIdArg(args, singleLocked),
    };
  }

  return { kind: 'allow', args };
}

/** @internal */
export function _launchpadPrefixesForTests(): readonly string[] {
  return LAUNCHPAD_MCP_PREFIXES;
}
