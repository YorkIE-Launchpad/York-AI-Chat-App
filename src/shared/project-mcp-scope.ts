/**
 * Hard-scope Hub MCP project tools to the session's locked Project/Client workspace.
 * Prompt-only locks are insufficient — Hub list/get tools are org-wide under RBAC.
 */

import {
  normalizeSessionDivision,
  parseClientDivisionProjects,
  resolveProjectAllowlist,
  type SessionDivisionFields,
} from './workspace-division';

/** Hub MCP name prefixes (sanitized mcp__Server__tool form). */
const HUB_MCP_PREFIXES = ['mcp__york_ie_hub__', 'mcp__hub__'] as const;

/** Tools that take a project id — inject locked id or reject a different one. */
const HUB_PROJECT_ID_TOOLS = new Set([
  'get_project',
  'list_project_allocations',
  'get_project_allocation_timeline',
  'get_project_bench_suggestions',
  'list_project_release_notes',
  'get_project_jira_quality',
  'send_project_bench_suggestions_chat',
]);

/** Tools that return multi-project payloads — call then filter to locked project(s). */
const HUB_PROJECT_LIST_TOOLS = new Set([
  'list_projects',
  'list_project_summaries',
  'get_project_red_flag_analytics',
  'search_organization',
]);

const PROJECT_ID_ARG_KEYS = [
  'projectId',
  'id',
  'project_id',
  'timesheet_project_id',
  'timesheetProjectId',
] as const;

/** Default arg key when injecting into empty Hub tool args (per Hub MCP schemas). */
const HUB_TOOL_DEFAULT_ID_ARG: Partial<Record<string, string>> = {
  get_project: 'projectId',
  list_project_allocations: 'project_id',
  get_project_allocation_timeline: 'project_id',
  get_project_bench_suggestions: 'project_id',
  list_project_release_notes: 'project_id',
  get_project_jira_quality: 'project_id',
  send_project_bench_suggestions_chat: 'project_id',
};

const PROJECT_NAME_KEYS = [
  'name',
  'title',
  'project_name',
  'projectName',
  'project_title',
] as const;

export type ProjectScopedMcpPrepare =
  | { kind: 'allow'; args: Record<string, unknown>; filterResult: boolean }
  | { kind: 'block'; message: string; attemptedProjectId?: string };

export type ProjectScopeViolationNotice = {
  message: string;
  toolName: string;
  attemptedProjectId?: string;
  sessionId?: string;
  hubProjectId?: string | null;
  hubProjectName?: string | null;
};

export type OnProjectScopeViolation = (info: ProjectScopeViolationNotice) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHubMcpToolName(toolName: string): boolean {
  const lowered = toolName.toLowerCase();
  return HUB_MCP_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/** Original Hub tool name from mcp__York_IE_HUB__get_project → get_project. */
export function hubMcpOriginalToolName(toolName: string): string | null {
  if (!isHubMcpToolName(toolName)) {
    return null;
  }
  const parts = toolName.split('__');
  if (parts.length < 3) {
    return null;
  }
  return parts.slice(2).join('__').toLowerCase();
}

export function projectScopeRefuseMessage(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'client' && normalized.clientName) {
    return [
      'Incorrect use. This attempt will be reported.',
      `This session is scoped to client "${normalized.clientName}" and its projects only.`,
      'Switch Client or Project workspace (or General) in the sidebar to query another client.',
    ].join(' ');
  }
  const name = normalized.hubProjectName || normalized.hubProjectId || 'this project';
  return [
    'Incorrect use. This attempt will be reported.',
    `This session is scoped to project "${name}"` +
      (normalized.hubProjectId ? ` (hub project id: ${normalized.hubProjectId})` : '') +
      '.',
    'Switch Project workspace (or General) in the sidebar to query another project.',
  ].join(' ');
}

function hubBlockedWithoutAllocationMessage(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  void session;
  return [
    'Incorrect use. This attempt will be reported.',
    'This workspace has no Hub project allocation. Hub MCP tools are blocked — use LaunchPad MCP tools only.',
  ].join(' ');
}

function clientDivisionRequiresProjectIdMessage(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  return [
    projectScopeRefuseMessage(session),
    'You must specify an in-scope Hub project id for this tool.',
  ].join(' ');
}

function emptyInScopeMessage(session: Partial<SessionDivisionFields> | null | undefined): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'client' && normalized.clientName) {
    return `No in-scope data for client "${normalized.clientName}" in this tool result. This session is locked to that client's projects only.`;
  }
  const name = normalized.hubProjectName || normalized.hubProjectId || 'this project';
  return `No in-scope data for project "${name}" in this tool result. This session is locked to that project only.`;
}

function normalizeProjectLabel(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

function readProjectIdArg(args: Record<string, unknown>): string | null {
  for (const key of PROJECT_ID_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function injectProjectIdArg(
  args: Record<string, unknown>,
  hubProjectId: string,
  hubToolName?: string | null
): Record<string, unknown> {
  const next = { ...args };
  for (const key of PROJECT_ID_ARG_KEYS) {
    if (key in next) {
      next[key] = hubProjectId;
      return next;
    }
  }
  const defaultKey = (hubToolName && HUB_TOOL_DEFAULT_ID_ARG[hubToolName]) || 'projectId';
  next[defaultKey] = hubProjectId;
  return next;
}

function itemMatchesAllowlist(
  item: Record<string, unknown>,
  allowlist: { hubIds: Set<string>; launchpadIds: Set<number> },
  projectNames: Set<string>
): boolean {
  for (const key of PROJECT_ID_ARG_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() && allowlist.hubIds.has(value.trim())) {
      return true;
    }
  }
  for (const key of PROJECT_NAME_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      if (projectNames.has(normalizeProjectLabel(value))) {
        return true;
      }
    }
  }
  return false;
}

function collectProjectNames(session: Partial<SessionDivisionFields>): Set<string> {
  const names = new Set<string>();
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'project') {
    const name = normalized.hubProjectName || normalized.launchpadProjectName;
    if (name) names.add(normalizeProjectLabel(name));
  } else if (normalized.division === 'client') {
    for (const project of parseClientDivisionProjects(normalized.clientProjectIds)) {
      names.add(normalizeProjectLabel(project.name));
    }
  }
  return names;
}

function filterUnknownForAllowlist(
  value: unknown,
  allowlist: { hubIds: Set<string>; launchpadIds: Set<number> },
  projectNames: Set<string>
): { value: unknown; changed: boolean; keptAny: boolean } {
  if (Array.isArray(value)) {
    const filtered = value.filter(
      (item) => isRecord(item) && itemMatchesAllowlist(item, allowlist, projectNames)
    );
    const looksLikeProjectList = value.some(
      (item) =>
        isRecord(item) &&
        (PROJECT_ID_ARG_KEYS.some((k) => typeof item[k] === 'string') ||
          PROJECT_NAME_KEYS.some((k) => typeof item[k] === 'string'))
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

  if (!isRecord(value)) {
    return { value, changed: false, keptAny: true };
  }

  if (itemMatchesAllowlist(value, allowlist, projectNames)) {
    return { value, changed: false, keptAny: true };
  }
  if (
    PROJECT_ID_ARG_KEYS.some((k) => typeof value[k] === 'string') ||
    PROJECT_NAME_KEYS.some((k) => typeof value[k] === 'string')
  ) {
    const hasNestedArrays = Object.values(value).some((v) => Array.isArray(v));
    if (!hasNestedArrays) {
      return { value: null, changed: true, keptAny: false };
    }
  }

  let changed = false;
  let keptAny = false;
  let sawProjectList = false;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const filtered = filterUnknownForAllowlist(nested, allowlist, projectNames);
    next[key] = filtered.value;
    if (filtered.changed) {
      changed = true;
      sawProjectList = true;
    }
    if (filtered.keptAny) {
      keptAny = true;
    } else if (filtered.changed) {
      sawProjectList = true;
    }
  }
  if (sawProjectList && !keptAny) {
    return { value: next, changed: true, keptAny: false };
  }
  return { value: next, changed, keptAny: keptAny || !sawProjectList };
}

/**
 * Prepare Hub MCP args for a Project/Client workspace session.
 * Non-project divisions and non-Hub tools pass through unchanged.
 */
export function prepareProjectScopedMcpArgs(
  toolName: string,
  args: Record<string, unknown>,
  session: Partial<SessionDivisionFields> | null | undefined
): ProjectScopedMcpPrepare {
  const normalized = normalizeSessionDivision(session);
  const allowlist = resolveProjectAllowlist(session);
  const original = hubMcpOriginalToolName(toolName);

  if (!allowlist) {
    return { kind: 'allow', args, filterResult: false };
  }

  if (allowlist.hubIds.size === 0) {
    if (original) {
      return {
        kind: 'block',
        message: hubBlockedWithoutAllocationMessage(session),
      };
    }
    return { kind: 'allow', args, filterResult: false };
  }

  if (!original) {
    return { kind: 'allow', args, filterResult: false };
  }

  const isClientDivision = normalized.division === 'client';
  const singleHubId =
    !isClientDivision && normalized.hubProjectId ? normalized.hubProjectId : null;

  if (HUB_PROJECT_ID_TOOLS.has(original)) {
    const provided = readProjectIdArg(args);
    if (provided && !allowlist.hubIds.has(provided)) {
      return {
        kind: 'block',
        message: projectScopeRefuseMessage(session),
        attemptedProjectId: provided,
      };
    }
    if (isClientDivision) {
      if (!provided) {
        return {
          kind: 'block',
          message: clientDivisionRequiresProjectIdMessage(session),
        };
      }
      return { kind: 'allow', args, filterResult: false };
    }
    if (singleHubId) {
      return {
        kind: 'allow',
        args: injectProjectIdArg(args, singleHubId, original),
        filterResult: false,
      };
    }
    return { kind: 'allow', args, filterResult: false };
  }

  if (HUB_PROJECT_LIST_TOOLS.has(original)) {
    return { kind: 'allow', args, filterResult: true };
  }

  return { kind: 'allow', args, filterResult: false };
}

/**
 * Filter Hub multi-project tool result text down to locked project(s).
 */
export function applyProjectScopedMcpResultFilter(
  toolName: string,
  resultText: string,
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const allowlist = resolveProjectAllowlist(session);
  if (!allowlist || allowlist.hubIds.size === 0) {
    return resultText;
  }
  const original = hubMcpOriginalToolName(toolName);
  if (!original || !HUB_PROJECT_LIST_TOOLS.has(original)) {
    return resultText;
  }

  const projectNames = collectProjectNames(session ?? {});
  const trimmed = resultText.trim();
  if (!trimmed) {
    return emptyInScopeMessage(session);
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const filtered = filterUnknownForAllowlist(parsed, allowlist, projectNames);
    if (!filtered.keptAny) {
      return emptyInScopeMessage(session);
    }
    if (!filtered.changed) {
      return resultText;
    }
    return JSON.stringify(filtered.value);
  } catch {
    const lower = trimmed.toLowerCase();
    const idHit = Array.from(allowlist.hubIds).some((id) => lower.includes(id.toLowerCase()));
    const nameHit = Array.from(projectNames).some((name) => lower.includes(name));
    if (idHit || nameHit) {
      return resultText;
    }
    return emptyInScopeMessage(session);
  }
}
