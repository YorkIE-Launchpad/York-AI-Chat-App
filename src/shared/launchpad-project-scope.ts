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

/** Tools that return multi-project payloads — filter to locked project(s). */
const LP_PROJECT_LIST_TOOLS = new Set(['list_project_names']);

export type LaunchpadScopedMcpPrepare =
  | { kind: 'allow'; args: Record<string, unknown>; filterResult?: boolean }
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

function clientDivisionRequiresLpProjectIdMessage(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  return [
    launchpadScopeRefuseMessage(session),
    'You must specify an in-scope LaunchPad project id for this tool.',
  ].join(' ');
}

function emptyLpInScopeMessage(session: Partial<SessionDivisionFields> | null | undefined): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'client' && normalized.clientName) {
    return `No in-scope LaunchPad data for client "${normalized.clientName}" in this tool result.`;
  }
  const name =
    normalized.launchpadProjectName ||
    (normalized.launchpadProjectId != null ? `LP ${normalized.launchpadProjectId}` : 'this project');
  return `No in-scope LaunchPad data for project "${name}" in this tool result.`;
}

function readLpIdFromItem(item: Record<string, unknown>): number | null {
  for (const key of LP_PROJECT_ID_ARG_KEYS) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function filterLpValueForAllowlist(
  value: unknown,
  allowlist: { launchpadIds: Set<number> }
): { value: unknown; changed: boolean; keptAny: boolean } {
  if (Array.isArray(value)) {
    const filtered = value.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        (() => {
          const id = readLpIdFromItem(item as Record<string, unknown>);
          return id != null && allowlist.launchpadIds.has(id);
        })()
    );
    const looksLikeProjectList = value.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        readLpIdFromItem(item as Record<string, unknown>) != null
    );
    if (!looksLikeProjectList) {
      return { value, changed: false, keptAny: true };
    }
    return {
      value: filtered,
      changed: filtered.length !== value.length,
      keptAny: filtered.length > 0,
    };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const id = readLpIdFromItem(value as Record<string, unknown>);
    if (id != null) {
      const kept = allowlist.launchpadIds.has(id);
      return { value: kept ? value : null, changed: !kept, keptAny: kept };
    }
  }
  return { value, changed: false, keptAny: true };
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
    return { kind: 'allow', args, filterResult: false };
  }

  const original = launchpadMcpOriginalToolName(toolName);
  if (!original) {
    return { kind: 'allow', args, filterResult: false };
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
    return { kind: 'allow', args, filterResult: false };
  }

  if (provided != null && !allowlist.launchpadIds.has(provided)) {
    return {
      kind: 'block',
      message: launchpadScopeRefuseMessage(session),
      attemptedProjectId: String(provided),
    };
  }

  if (isClientDivision) {
    if (
      (LP_PROJECT_ID_TOOLS.has(original) || looksScoped) &&
      provided == null
    ) {
      return {
        kind: 'block',
        message: clientDivisionRequiresLpProjectIdMessage(session),
      };
    }
    return { kind: 'allow', args, filterResult: false };
  }

  if (singleLocked != null) {
    return {
      kind: 'allow',
      args: injectLpProjectIdArg(args, singleLocked),
      filterResult: false,
    };
  }

  if (LP_PROJECT_LIST_TOOLS.has(original)) {
    return { kind: 'allow', args, filterResult: true };
  }

  return { kind: 'allow', args, filterResult: false };
}

/**
 * Filter LaunchPad multi-project tool result text down to locked project(s).
 */
export function applyLaunchpadScopedMcpResultFilter(
  toolName: string,
  resultText: string,
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const allowlist = resolveProjectAllowlist(session);
  if (!allowlist || allowlist.launchpadIds.size === 0) {
    return resultText;
  }
  const original = launchpadMcpOriginalToolName(toolName);
  if (!original || !LP_PROJECT_LIST_TOOLS.has(original)) {
    return resultText;
  }

  const trimmed = resultText.trim();
  if (!trimmed) {
    return emptyLpInScopeMessage(session);
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const filtered = filterLpValueForAllowlist(parsed, allowlist);
    if (!filtered.keptAny) {
      return emptyLpInScopeMessage(session);
    }
    if (!filtered.changed) {
      return resultText;
    }
    return JSON.stringify(filtered.value);
  } catch {
    const lower = trimmed.toLowerCase();
    const idHit = Array.from(allowlist.launchpadIds).some((id) =>
      lower.includes(String(id))
    );
    if (idHit) {
      return resultText;
    }
    return emptyLpInScopeMessage(session);
  }
}

/** @internal */
export function _launchpadPrefixesForTests(): readonly string[] {
  return LAUNCHPAD_MCP_PREFIXES;
}
