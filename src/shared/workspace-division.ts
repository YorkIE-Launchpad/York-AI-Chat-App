/**
 * Workspace divisions: General / Hub / Project.
 * Chats + experience memory are isolated per division; core memory stays global.
 */

export type WorkspaceDivisionKind = 'general' | 'hub' | 'project';

export interface ActiveDivisionGeneral {
  kind: 'general';
}

export interface ActiveDivisionHub {
  kind: 'hub';
}

export interface ActiveDivisionProject {
  kind: 'project';
  hubProjectId: string;
  hubProjectName: string;
}

export type ActiveDivision = ActiveDivisionGeneral | ActiveDivisionHub | ActiveDivisionProject;

export interface SessionDivisionFields {
  division: WorkspaceDivisionKind;
  hubProjectId?: string | null;
  hubProjectName?: string | null;
}

export interface AllocatedHubProject {
  id: string;
  name: string;
  hours?: number;
  title?: string;
}

export const DIVISION_STORAGE_KEY = 'yorkie.activeDivision';

export function parseDivisionKind(value: unknown): WorkspaceDivisionKind {
  if (value === 'hub' || value === 'project' || value === 'general') {
    return value;
  }
  return 'general';
}

export function normalizeSessionDivision(
  input?: Partial<SessionDivisionFields> | null
): SessionDivisionFields {
  const division = parseDivisionKind(input?.division);
  if (division === 'project') {
    const hubProjectId =
      typeof input?.hubProjectId === 'string' && input.hubProjectId.trim()
        ? input.hubProjectId.trim()
        : null;
    const hubProjectName =
      typeof input?.hubProjectName === 'string' && input.hubProjectName.trim()
        ? input.hubProjectName.trim()
        : null;
    if (!hubProjectId) {
      return { division: 'general', hubProjectId: null, hubProjectName: null };
    }
    return {
      division: 'project',
      hubProjectId,
      hubProjectName: hubProjectName || hubProjectId,
    };
  }
  return { division, hubProjectId: null, hubProjectName: null };
}

/** Experience-memory workspace key for a session's division. */
export function divisionMemoryKey(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'hub') {
    return 'vecos://hub';
  }
  if (normalized.division === 'project' && normalized.hubProjectId) {
    return `vecos://project/${normalized.hubProjectId}`;
  }
  return 'vecos://general';
}

export function activeDivisionFromSession(
  session: Partial<SessionDivisionFields> | null | undefined
): ActiveDivision {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'hub') {
    return { kind: 'hub' };
  }
  if (normalized.division === 'project' && normalized.hubProjectId) {
    return {
      kind: 'project',
      hubProjectId: normalized.hubProjectId,
      hubProjectName: normalized.hubProjectName || normalized.hubProjectId,
    };
  }
  return { kind: 'general' };
}

export function sessionMatchesActiveDivision(
  session: Partial<SessionDivisionFields> | null | undefined,
  active: ActiveDivision | null | undefined
): boolean {
  if (!active) {
    return false;
  }
  const normalized = normalizeSessionDivision(session);
  if (active.kind === 'general') {
    return normalized.division === 'general';
  }
  if (active.kind === 'hub') {
    return normalized.division === 'hub';
  }
  return normalized.division === 'project' && normalized.hubProjectId === active.hubProjectId;
}

export function divisionLabel(active: ActiveDivision | null | undefined): string {
  if (!active) {
    return 'Choose workspace';
  }
  if (active.kind === 'general') {
    return 'General';
  }
  if (active.kind === 'hub') {
    return 'Hub';
  }
  return active.hubProjectName || active.hubProjectId;
}

export function loadActiveDivisionFromStorage(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null
): ActiveDivision | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(DIVISION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const kind = (parsed as { kind?: unknown }).kind;
    if (kind === 'general' || kind === 'hub') {
      return { kind };
    }
    if (kind === 'project') {
      const hubProjectId = (parsed as { hubProjectId?: unknown }).hubProjectId;
      const hubProjectName = (parsed as { hubProjectName?: unknown }).hubProjectName;
      if (typeof hubProjectId === 'string' && hubProjectId.trim()) {
        return {
          kind: 'project',
          hubProjectId: hubProjectId.trim(),
          hubProjectName:
            typeof hubProjectName === 'string' && hubProjectName.trim()
              ? hubProjectName.trim()
              : hubProjectId.trim(),
        };
      }
    }
  } catch {
    // ignore corrupt storage
  }
  return null;
}

export function saveActiveDivisionToStorage(
  active: ActiveDivision | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined = typeof localStorage !==
  'undefined'
    ? localStorage
    : null
): void {
  if (!storage) {
    return;
  }
  if (!active) {
    storage.removeItem(DIVISION_STORAGE_KEY);
    return;
  }
  storage.setItem(DIVISION_STORAGE_KEY, JSON.stringify(active));
}

/** Build system-prompt block for the active session division. */
export function buildDivisionSystemPrompt(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'hub') {
    return [
      '<workspace_division>',
      'You are in Hub mode (York IE HRMS / people / culture, plus Hub clients & projects data).',
      'HARD RULES — these override general "start doing it" behavior when the request is out of scope:',
      'IN SCOPE: Hub people, culture, HR, leave, timesheets, org structure, Hub clients/projects, staffing/allocations, Hub requests, kudos — any data available via Hub tools.',
      'OUT OF SCOPE (REFUSE): personal tasks; hobby coding or unrelated file work; software delivery work outside Hub (features, bugs, releases via Launchpad/Pulse); general research unrelated to Hub.',
      'Hub client/project records and allocations ARE in scope. Delivery tooling (Launchpad/Pulse) is not — switch to a Project workspace for that.',
      'On refuse: one short sentence, then tell the user to switch to General (or a Project workspace) in the sidebar. Do not call off-scope tools.',
      '</workspace_division>',
    ].join('\n');
  }
  if (normalized.division === 'project' && normalized.hubProjectId) {
    const name = normalized.hubProjectName || normalized.hubProjectId;
    return [
      '<workspace_division>',
      `You are locked to project "${name}" (hub project id: ${normalized.hubProjectId}).`,
      'HARD RULES — these override general "start doing it" behavior when the request is out of scope:',
      `IN SCOPE: delivery, Hub data, Launchpad/Pulse/Jira/comms for "${name}" only. Pass this project id/name to tools that accept a project filter.`,
      'OUT OF SCOPE (REFUSE): personal use; general company Q&A unrelated to this project; other clients/projects; Hub-only HR (personal leave, org gossip) unless it is staffing/allocations for THIS project.',
      'On refuse: one short sentence, then tell the user to switch to General or the correct Project via the sidebar. Do not execute off-scope tools.',
      'Never query, summarize, or compare data for other clients or projects. If a tool returns data outside this project, ignore it and say you are scoped to this project only.',
      '</workspace_division>',
    ].join('\n');
  }
  return [
    '<workspace_division>',
    'You are in General mode (personal and general company use).',
    '</workspace_division>',
  ].join('\n');
}

/**
 * MCP tool-name prefixes (lowercase) excluded in Hub division.
 * Matches sanitized server names used in mcp__Server__tool form.
 */
export const HUB_DIVISION_EXCLUDED_MCP_PREFIXES = [
  'mcp__r_d_launchpad__',
  'mcp__launchpad__',
  'mcp__r_d_pulse__',
  'mcp__gtm_pulse__',
] as const;

export function isMcpToolExcludedInHubDivision(toolName: string): boolean {
  const lowered = toolName.toLowerCase();
  return HUB_DIVISION_EXCLUDED_MCP_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

export function filterMcpToolsForDivision<T extends { name: string }>(
  tools: T[],
  session: Partial<SessionDivisionFields> | null | undefined
): T[] {
  const division = normalizeSessionDivision(session).division;
  if (division !== 'hub') {
    return tools;
  }
  return tools.filter((tool) => !isMcpToolExcludedInHubDivision(tool.name));
}
