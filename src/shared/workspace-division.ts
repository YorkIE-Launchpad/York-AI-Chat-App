/**
 * Workspace divisions: General / Hub / Project / Folder.
 * Chats + experience memory are isolated per division; core memory stays global.
 */

import {
  canonicalKeyForUnified,
  hubCanonicalKey,
  launchpadCanonicalKey,
  type CompanyProjectSources,
  type UnifiedCompanyProject,
} from './unified-company-projects';

export type WorkspaceDivisionKind = 'general' | 'hub' | 'project' | 'folder';

export interface ActiveDivisionGeneral {
  kind: 'general';
}

export interface ActiveDivisionHub {
  kind: 'hub';
}

export interface ActiveDivisionFolder {
  kind: 'folder';
  folderId: string;
  folderName: string;
}

export interface ActiveDivisionProject {
  kind: 'project';
  canonicalKey: string;
  name: string;
  hubProjectId?: string;
  hubProjectName?: string;
  launchpadProjectId?: number;
  launchpadProjectName?: string;
  sources: CompanyProjectSources;
}

export type ActiveDivision =
  | ActiveDivisionGeneral
  | ActiveDivisionHub
  | ActiveDivisionProject
  | ActiveDivisionFolder;

export interface SessionDivisionFields {
  division: WorkspaceDivisionKind;
  hubProjectId?: string | null;
  hubProjectName?: string | null;
  launchpadProjectId?: number | null;
  launchpadProjectName?: string | null;
  folderId?: string | null;
  folderName?: string | null;
  canonicalKey?: string | null;
}

export interface AllocatedHubProject {
  id: string;
  name: string;
  hours?: number;
  title?: string;
}

export interface PersonalFolder {
  id: string;
  name: string;
  instructions?: string | null;
  createdAt: number;
  updatedAt: number;
}

export const DIVISION_STORAGE_KEY = 'yorkie.activeDivision';

export function parseDivisionKind(value: unknown): WorkspaceDivisionKind {
  if (value === 'hub' || value === 'project' || value === 'general' || value === 'folder') {
    return value;
  }
  return 'general';
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

export function projectDisplayName(fields: {
  name?: string | null;
  hubProjectName?: string | null;
  launchpadProjectName?: string | null;
  hubProjectId?: string | null;
  launchpadProjectId?: number | null;
}): string {
  return (
    parseOptionalString(fields.name) ||
    parseOptionalString(fields.hubProjectName) ||
    parseOptionalString(fields.launchpadProjectName) ||
    parseOptionalString(fields.hubProjectId) ||
    (fields.launchpadProjectId != null ? `LP ${fields.launchpadProjectId}` : 'Project')
  );
}

export function activeDivisionFromUnifiedProject(
  project: UnifiedCompanyProject
): ActiveDivisionProject {
  const sources: CompanyProjectSources = {
    ...(project.sources.hub ? { hub: true } : {}),
    ...(project.sources.launchpad ? { launchpad: true } : {}),
  };
  return {
    kind: 'project',
    canonicalKey: canonicalKeyForUnified(project),
    name: project.name,
    hubProjectId: project.hubProjectId,
    hubProjectName: project.hubProjectName ?? project.name,
    launchpadProjectId: project.launchpadProjectId,
    launchpadProjectName: project.launchpadProjectName,
    sources,
  };
}

export function normalizeSessionDivision(
  input?: Partial<SessionDivisionFields> | null
): SessionDivisionFields {
  const division = parseDivisionKind(input?.division);

  if (division === 'folder') {
    const folderId = parseOptionalString(input?.folderId);
    const folderName = parseOptionalString(input?.folderName);
    if (!folderId) {
      return {
        division: 'general',
        hubProjectId: null,
        hubProjectName: null,
        launchpadProjectId: null,
        launchpadProjectName: null,
        folderId: null,
        folderName: null,
        canonicalKey: null,
      };
    }
    return {
      division: 'folder',
      hubProjectId: null,
      hubProjectName: null,
      launchpadProjectId: null,
      launchpadProjectName: null,
      folderId,
      folderName: folderName || folderId,
      canonicalKey: null,
    };
  }

  if (division === 'project') {
    const hubProjectId = parseOptionalString(input?.hubProjectId);
    const hubProjectName = parseOptionalString(input?.hubProjectName);
    const launchpadProjectId = parseOptionalNumber(input?.launchpadProjectId);
    const launchpadProjectName = parseOptionalString(input?.launchpadProjectName);

    if (!hubProjectId && launchpadProjectId == null) {
      return {
        division: 'general',
        hubProjectId: null,
        hubProjectName: null,
        launchpadProjectId: null,
        launchpadProjectName: null,
        folderId: null,
        folderName: null,
        canonicalKey: null,
      };
    }

    const canonicalKey =
      parseOptionalString(input?.canonicalKey) ||
      (hubProjectId
        ? hubCanonicalKey(hubProjectId)
        : launchpadCanonicalKey(launchpadProjectId as number));

    return {
      division: 'project',
      hubProjectId,
      hubProjectName: hubProjectName || hubProjectId,
      launchpadProjectId,
      launchpadProjectName:
        launchpadProjectName || (launchpadProjectId != null ? String(launchpadProjectId) : null),
      folderId: null,
      folderName: null,
      canonicalKey,
    };
  }

  if (division === 'hub') {
    return {
      division: 'hub',
      hubProjectId: null,
      hubProjectName: null,
      launchpadProjectId: null,
      launchpadProjectName: null,
      folderId: null,
      folderName: null,
      canonicalKey: null,
    };
  }

  return {
    division: 'general',
    hubProjectId: null,
    hubProjectName: null,
    launchpadProjectId: null,
    launchpadProjectName: null,
    folderId: null,
    folderName: null,
    canonicalKey: null,
  };
}

/** Experience-memory workspace key for a session's division. */
export function divisionMemoryKey(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'hub') {
    return 'vecos://hub';
  }
  if (normalized.division === 'folder' && normalized.folderId) {
    return `vecos://folder/${normalized.folderId}`;
  }
  if (normalized.division === 'project') {
    // Keep hub-backed key shape for backward-compatible experience memory.
    if (normalized.hubProjectId) {
      return `vecos://project/${normalized.hubProjectId}`;
    }
    if (normalized.launchpadProjectId != null) {
      return `vecos://project/lp/${normalized.launchpadProjectId}`;
    }
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
  if (normalized.division === 'folder' && normalized.folderId) {
    return {
      kind: 'folder',
      folderId: normalized.folderId,
      folderName: normalized.folderName || normalized.folderId,
    };
  }
  if (normalized.division === 'project') {
    const sources: CompanyProjectSources = {
      ...(normalized.hubProjectId ? { hub: true } : {}),
      ...(normalized.launchpadProjectId != null ? { launchpad: true } : {}),
    };
    return {
      kind: 'project',
      canonicalKey:
        normalized.canonicalKey ||
        (normalized.hubProjectId
          ? hubCanonicalKey(normalized.hubProjectId)
          : launchpadCanonicalKey(normalized.launchpadProjectId as number)),
      name: projectDisplayName(normalized),
      hubProjectId: normalized.hubProjectId || undefined,
      hubProjectName: normalized.hubProjectName || undefined,
      launchpadProjectId: normalized.launchpadProjectId ?? undefined,
      launchpadProjectName: normalized.launchpadProjectName || undefined,
      sources,
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
  if (active.kind === 'folder') {
    return normalized.division === 'folder' && normalized.folderId === active.folderId;
  }
  // Project: match hub id, launchpad id, or canonical key (legacy hub-only sessions included).
  if (normalized.division !== 'project') {
    return false;
  }
  if (
    active.canonicalKey &&
    normalized.canonicalKey &&
    active.canonicalKey === normalized.canonicalKey
  ) {
    return true;
  }
  if (
    active.hubProjectId &&
    normalized.hubProjectId &&
    active.hubProjectId === normalized.hubProjectId
  ) {
    return true;
  }
  if (
    active.launchpadProjectId != null &&
    normalized.launchpadProjectId != null &&
    active.launchpadProjectId === normalized.launchpadProjectId
  ) {
    return true;
  }
  return false;
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
  if (active.kind === 'folder') {
    return active.folderName || 'Folder';
  }
  return active.name || projectDisplayName(active);
}

export function companyProjectSourceLabel(sources: CompanyProjectSources | undefined): string {
  if (!sources) return '';
  const hub = Boolean(sources.hub);
  const lp = Boolean(sources.launchpad);
  if (hub && lp) return 'Hub · LaunchPad';
  if (hub) return 'Hub';
  if (lp) return 'LaunchPad';
  return '';
}

/** Coerce stored/legacy ActiveDivision JSON into the current shape. */
export function coerceActiveDivision(parsed: unknown): ActiveDivision | null {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind === 'general' || kind === 'hub') {
    return { kind };
  }
  if (kind === 'folder') {
    const folderId = parseOptionalString((parsed as { folderId?: unknown }).folderId);
    const folderName = parseOptionalString((parsed as { folderName?: unknown }).folderName);
    if (folderId) {
      return { kind: 'folder', folderId, folderName: folderName || folderId };
    }
    return null;
  }
  if (kind === 'project') {
    const p = parsed as {
      hubProjectId?: unknown;
      hubProjectName?: unknown;
      launchpadProjectId?: unknown;
      launchpadProjectName?: unknown;
      canonicalKey?: unknown;
      name?: unknown;
      sources?: unknown;
    };
    const hubProjectId = parseOptionalString(p.hubProjectId);
    const launchpadProjectId = parseOptionalNumber(p.launchpadProjectId);
    if (!hubProjectId && launchpadProjectId == null) {
      return null;
    }
    const hubProjectName = parseOptionalString(p.hubProjectName);
    const launchpadProjectName = parseOptionalString(p.launchpadProjectName);
    const name =
      parseOptionalString(p.name) ||
      hubProjectName ||
      launchpadProjectName ||
      hubProjectId ||
      (launchpadProjectId != null ? `LP ${launchpadProjectId}` : 'Project');
    const sourcesRaw =
      p.sources && typeof p.sources === 'object' ? (p.sources as CompanyProjectSources) : null;
    const sources: CompanyProjectSources = sourcesRaw
      ? {
          ...(sourcesRaw.hub ? { hub: true } : {}),
          ...(sourcesRaw.launchpad ? { launchpad: true } : {}),
        }
      : {
          ...(hubProjectId ? { hub: true } : {}),
          ...(launchpadProjectId != null ? { launchpad: true } : {}),
        };
    const canonicalKey =
      parseOptionalString(p.canonicalKey) ||
      (hubProjectId
        ? hubCanonicalKey(hubProjectId)
        : launchpadCanonicalKey(launchpadProjectId as number));
    return {
      kind: 'project',
      canonicalKey,
      name,
      hubProjectId: hubProjectId || undefined,
      hubProjectName: hubProjectName || undefined,
      launchpadProjectId: launchpadProjectId ?? undefined,
      launchpadProjectName: launchpadProjectName || undefined,
      sources,
    };
  }
  return null;
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
    return coerceActiveDivision(JSON.parse(raw) as unknown);
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

/**
 * Per-turn user-prompt block so the model treats project-scoped chats as
 * already bound to the selected Hub/LaunchPad project — even when the user
 * omits the project name ("status?", "open bugs", "who's on the team?").
 * Empty outside project division.
 */
export function buildDivisionActiveProjectContext(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division !== 'project') {
    return '';
  }

  const name = projectDisplayName(normalized);
  const lines = [
    '<active_project_context>',
    `SELECTED PROJECT (default subject of this chat): "${name}".`,
    'The user already chose this project in the workspace switcher. They do not need to repeat the project name.',
    'Treat every project-related question and tool call as about THIS project only, unless they clearly name a different project (then refuse / switch workspace).',
    'Never ask which project they mean. Never list all company projects to guess.',
  ];
  if (normalized.hubProjectId) {
    lines.push(`- Hub project id: ${normalized.hubProjectId}`);
    lines.push(`- Hub project name: ${normalized.hubProjectName || name}`);
  }
  if (normalized.launchpadProjectId != null) {
    lines.push(`- LaunchPad project id: ${normalized.launchpadProjectId}`);
    lines.push(`- LaunchPad project name: ${normalized.launchpadProjectName || name}`);
  }
  lines.push(
    'When tools accept project id filters, pass the ids above. When tools take free-text search (Slack, Gmail, meetings, Drive, Jira, Confluence), include this project name in the query.',
    'Skip Hub/LaunchPad list-then-match steps when the relevant id is present above.',
    '</active_project_context>'
  );
  return lines.join('\n');
}

function projectDivisionHardRules(name: string): string[] {
  return [
    'DEFAULT SUBJECT: when the user does not name a project, assume they mean this project. Use its name and ids in tool calls/searches. Do not ask which project.',
    'HARD RULES — these override general "start doing it" behavior when the request is out of scope:',
    `IN SCOPE: delivery, Hub data, Launchpad/Pulse/Jira/comms for "${name}" only. Pass hub and/or launchpad project ids to tools that accept them.`,
    'OUT OF SCOPE (REFUSE): personal use; general company Q&A unrelated to this project; other clients/projects; Hub-only HR unless staffing/allocations for THIS project.',
    'On refuse: say "Incorrect use. This will be reported." then tell the user to switch to General or the correct Project via the sidebar. Do not execute off-scope tools.',
    'Never query, summarize, or compare data for other clients or projects. If a tool returns data outside this project, ignore it and say you are scoped to this project only.',
    `If the user names another project (not "${name}"), refuse with "Incorrect use. This will be reported." and tell them to switch Project workspace in the sidebar.`,
  ];
}

/** Build system-prompt block for the active session division. */
export function buildDivisionSystemPrompt(
  session: Partial<SessionDivisionFields> | null | undefined,
  options?: { folderInstructions?: string | null }
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'hub') {
    return [
      '<workspace_division>',
      'You are in Hub mode (York IE HRMS / people / culture, plus Hub clients & projects data).',
      'HARD RULES — these override general "start doing it" behavior when the request is out of scope:',
      'IN SCOPE: Hub people, culture, HR, leave, timesheets, org structure, Hub clients/projects, staffing/allocations, Hub requests, kudos — any data available via Hub tools.',
      'IN SCOPE: When the user asks, export or save Hub analysis/results to local files (CSV, XLSX, Markdown, HTML, etc.) under this workspace — prefer outputs/ — using Write tools. Do not refuse and do not require switching to General for Hub data exports.',
      'OUT OF SCOPE (REFUSE): personal tasks unrelated to Hub; hobby coding or non-Hub software implementation; software delivery work outside Hub (features, bugs, releases via Launchpad/Pulse); general research unrelated to Hub. Do not refuse file exports that contain Hub data the user requested.',
      'Hub client/project records and allocations ARE in scope. Delivery tooling (Launchpad/Pulse) is not — switch to a Project workspace for that.',
      'On refuse: one short sentence, then tell the user to switch to General (or a Project workspace) in the sidebar. Do not call off-scope tools.',
      '</workspace_division>',
    ].join('\n');
  }

  if (normalized.division === 'folder' && normalized.folderId) {
    const name = normalized.folderName || normalized.folderId;
    const instructions = options?.folderInstructions?.trim();
    const lines = [
      '<workspace_division>',
      `You are in personal folder "${name}" under General (user-created project folder).`,
      'This is a personal workspace with OpenRouter / user-provided keys only — not a York Hub or LaunchPad company project.',
    ];
    if (instructions) {
      lines.push('Folder instructions from the user (follow these for this chat):', instructions);
    } else {
      lines.push(
        'Keep work relevant to this folder when the user sets instructions; otherwise behave like General.'
      );
    }
    lines.push('</workspace_division>');
    return lines.join('\n');
  }

  if (normalized.division === 'project') {
    const name = projectDisplayName(normalized);
    const idBits: string[] = [];
    if (normalized.hubProjectId) {
      idBits.push(`hub project id: ${normalized.hubProjectId}`);
    }
    if (normalized.launchpadProjectId != null) {
      idBits.push(`launchpad project id: ${normalized.launchpadProjectId}`);
    }
    const idLine = idBits.length ? ` (${idBits.join(', ')})` : '';
    const hardRules = projectDivisionHardRules(name);

    if (normalized.hubProjectId && normalized.launchpadProjectId != null) {
      return [
        '<workspace_division>',
        `You are locked to project "${name}"${idLine}.`,
        ...hardRules,
        '</workspace_division>',
      ].join('\n');
    }

    if (normalized.hubProjectId) {
      return [
        '<workspace_division>',
        `You are locked to project "${name}" (hub project id: ${normalized.hubProjectId}).`,
        hardRules[0],
        'HARD RULES — these override general "start doing it" behavior when the request is out of scope:',
        `IN SCOPE: delivery, Hub data, Launchpad/Pulse/Jira/comms for "${name}" only. Pass this project id/name to tools that accept a project filter.`,
        'OUT OF SCOPE (REFUSE): personal use; general company Q&A unrelated to this project; other clients/projects; Hub-only HR (personal leave, org gossip) unless it is staffing/allocations for THIS project.',
        'On refuse: say "Incorrect use. This will be reported." then tell the user to switch to General or the correct Project via the sidebar. Do not execute off-scope tools.',
        'Never query, summarize, or compare data for other clients or projects. If a tool returns data outside this project, ignore it and say you are scoped to this project only.',
        `If the user names another project (not "${name}"), do not call Hub project tools for it — refuse with "Incorrect use. This will be reported." and tell them to switch Project workspace in the sidebar.`,
        '</workspace_division>',
      ].join('\n');
    }

    // LaunchPad-only: no Hub hard lock
    return [
      '<workspace_division>',
      `You are locked to LaunchPad project "${name}"${idLine}.`,
      hardRules[0],
      'HARD RULES — these override general "start doing it" behavior when the request is out of scope:',
      `IN SCOPE: LaunchPad delivery (features, bugs, releases, implement/preview) for "${name}" only. Pass launchpad project id ${normalized.launchpadProjectId} to LaunchPad tools.`,
      'No Hub project id is linked — do not invent one. Hub org tools are not project-locked; still avoid unrelated company Q&A.',
      'OUT OF SCOPE (REFUSE): other LaunchPad/Hub projects; personal use; general company HR.',
      'On refuse: say "Incorrect use. This will be reported." then tell the user to switch Project workspace in the sidebar.',
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

/**
 * General + personal folders are OpenRouter-only. Hub / Project keep the full catalog.
 * When division is omitted (background jobs / one-shots without a session), pass through.
 */
export function isProviderAllowedInDivision(
  provider: string | undefined | null,
  session: Partial<SessionDivisionFields> | null | undefined
): boolean {
  if (!provider) return false;
  const kind = session?.division;
  if (kind !== 'general' && kind !== 'hub' && kind !== 'project' && kind !== 'folder') {
    return true;
  }
  if (kind === 'general' || kind === 'folder') {
    return provider === 'openrouter';
  }
  return true;
}

export function filterModelsForDivision<T extends { provider: string }>(
  models: T[],
  session: Partial<SessionDivisionFields> | null | undefined
): T[] {
  const kind = session?.division;
  if (kind !== 'general' && kind !== 'folder') {
    return models;
  }
  return models.filter((m) => m.provider === 'openrouter');
}

export function generalWorkspaceOpenRouterOnlyMessage(): string {
  return 'General and personal Folders only use OpenRouter with your own API key (not York billing). Switch to Hub or a Project for York-managed Claude, GPT, or Gemini — or pick an OpenRouter model after adding your key in Settings → General.';
}

export function sessionFieldsFromActiveDivision(
  active: ActiveDivision | null
): Partial<SessionDivisionFields> {
  if (!active) return { division: 'hub' };
  if (active.kind === 'project') {
    return {
      division: 'project',
      hubProjectId: active.hubProjectId ?? null,
      hubProjectName: active.hubProjectName ?? active.name ?? null,
      launchpadProjectId: active.launchpadProjectId ?? null,
      launchpadProjectName: active.launchpadProjectName ?? null,
      canonicalKey: active.canonicalKey,
    };
  }
  if (active.kind === 'folder') {
    return {
      division: 'folder',
      folderId: active.folderId,
      folderName: active.folderName,
    };
  }
  return { division: active.kind };
}
