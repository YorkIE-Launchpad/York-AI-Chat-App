/**
 * Hard-scope Hub MCP project tools to the session's locked Project workspace.
 * Prompt-only locks are insufficient — Hub list/get tools are org-wide under RBAC.
 */

import { normalizeSessionDivision, type SessionDivisionFields } from './workspace-division';

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

/** Tools that return multi-project payloads — call then filter to locked project. */
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
  const name = normalized.hubProjectName || normalized.hubProjectId || 'this project';
  return [
    'Incorrect use. This attempt will be reported.',
    `This session is scoped to project "${name}"` +
      (normalized.hubProjectId ? ` (hub project id: ${normalized.hubProjectId})` : '') +
      '.',
    'Switch Project workspace (or General) in the sidebar to query another project.',
  ].join(' ');
}

function emptyInScopeMessage(session: Partial<SessionDivisionFields> | null | undefined): string {
  const normalized = normalizeSessionDivision(session);
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
  // Prefer overwriting an existing id-shaped key; otherwise use tool-specific default.
  for (const key of PROJECT_ID_ARG_KEYS) {
    if (key in next) {
      next[key] = hubProjectId;
      return next;
    }
  }
  const defaultKey =
    (hubToolName && HUB_TOOL_DEFAULT_ID_ARG[hubToolName]) || 'projectId';
  next[defaultKey] = hubProjectId;
  return next;
}

function itemMatchesLockedProject(
  item: Record<string, unknown>,
  hubProjectId: string,
  hubProjectName: string
): boolean {
  for (const key of PROJECT_ID_ARG_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() === hubProjectId) {
      return true;
    }
  }
  // Some list payloads use bare `id` for non-project entities — still match name/title.
  const lockedLabel = normalizeProjectLabel(hubProjectName);
  for (const key of PROJECT_NAME_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      if (normalizeProjectLabel(value) === lockedLabel) {
        return true;
      }
    }
  }
  return false;
}

function filterUnknownForProject(
  value: unknown,
  hubProjectId: string,
  hubProjectName: string
): { value: unknown; changed: boolean; keptAny: boolean } {
  if (Array.isArray(value)) {
    const filtered = value.filter(
      (item) => isRecord(item) && itemMatchesLockedProject(item, hubProjectId, hubProjectName)
    );
    // Only treat as a project list when items look like project records.
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

  // Single project object
  if (itemMatchesLockedProject(value, hubProjectId, hubProjectName)) {
    return { value, changed: false, keptAny: true };
  }
  if (
    PROJECT_ID_ARG_KEYS.some((k) => typeof value[k] === 'string') ||
    PROJECT_NAME_KEYS.some((k) => typeof value[k] === 'string')
  ) {
    // Looks like a single out-of-scope project record
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
    const filtered = filterUnknownForProject(nested, hubProjectId, hubProjectName);
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
 * Prepare Hub MCP args for a Project workspace session.
 * Non-project divisions and non-Hub tools pass through unchanged.
 */
export function prepareProjectScopedMcpArgs(
  toolName: string,
  args: Record<string, unknown>,
  session: Partial<SessionDivisionFields> | null | undefined
): ProjectScopedMcpPrepare {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division !== 'project' || !normalized.hubProjectId) {
    return { kind: 'allow', args, filterResult: false };
  }

  const original = hubMcpOriginalToolName(toolName);
  if (!original) {
    return { kind: 'allow', args, filterResult: false };
  }

  const hubProjectId = normalized.hubProjectId;

  if (HUB_PROJECT_ID_TOOLS.has(original)) {
    const provided = readProjectIdArg(args);
    if (provided && provided !== hubProjectId) {
      return {
        kind: 'block',
        message: projectScopeRefuseMessage(session),
        attemptedProjectId: provided,
      };
    }
    return {
      kind: 'allow',
      args: injectProjectIdArg(args, hubProjectId, original),
      filterResult: false,
    };
  }

  if (HUB_PROJECT_LIST_TOOLS.has(original)) {
    return { kind: 'allow', args, filterResult: true };
  }

  return { kind: 'allow', args, filterResult: false };
}

/**
 * Filter Hub multi-project tool result text down to the locked project.
 */
export function applyProjectScopedMcpResultFilter(
  toolName: string,
  resultText: string,
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division !== 'project' || !normalized.hubProjectId) {
    return resultText;
  }
  const original = hubMcpOriginalToolName(toolName);
  if (!original || !HUB_PROJECT_LIST_TOOLS.has(original)) {
    return resultText;
  }

  const hubProjectId = normalized.hubProjectId;
  const hubProjectName = normalized.hubProjectName || hubProjectId;
  const trimmed = resultText.trim();
  if (!trimmed) {
    return emptyInScopeMessage(session);
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const filtered = filterUnknownForProject(parsed, hubProjectId, hubProjectName);
    if (!filtered.keptAny) {
      return emptyInScopeMessage(session);
    }
    if (!filtered.changed) {
      return resultText;
    }
    return JSON.stringify(filtered.value);
  } catch {
    // Non-JSON: keep only if locked id or name appears; otherwise refuse leak.
    const lower = trimmed.toLowerCase();
    const idHit = lower.includes(hubProjectId.toLowerCase());
    const nameHit = lower.includes(hubProjectName.toLowerCase());
    if (idHit || nameHit) {
      return resultText;
    }
    return emptyInScopeMessage(session);
  }
}
