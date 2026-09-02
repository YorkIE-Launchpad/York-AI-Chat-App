/**
 * Workspace divisions: General / Hub / Project / Client / Folder.
 * Chats + experience memory are isolated per division; core memory stays global.
 */

import {
  canonicalKeyForUnified,
  clientCanonicalKey,
  groupUnifiedProjectsByClient,
  hubCanonicalKey,
  launchpadCanonicalKey,
  type CompanyProjectSources,
  type UnifiedCompanyProject,
} from './unified-company-projects';

export type WorkspaceDivisionKind = 'general' | 'hub' | 'project' | 'client' | 'folder';

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

export interface ClientDivisionProject {
  name: string;
  hubProjectId?: string;
  launchpadProjectId?: number;
  canonicalKey: string;
}

export interface ActiveDivisionClient {
  kind: 'client';
  canonicalKey: string;
  clientName: string;
  projects: ClientDivisionProject[];
}

export type ActiveDivision =
  | ActiveDivisionGeneral
  | ActiveDivisionHub
  | ActiveDivisionProject
  | ActiveDivisionClient
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
  clientName?: string | null;
  /** JSON array of ClientDivisionProject when division === 'client'. */
  clientProjectIds?: string | null;
}

export interface AllocatedHubProject {
  id: string;
  name: string;
  hours?: number;
  title?: string;
  clientName?: string;
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
  if (
    value === 'hub' ||
    value === 'project' ||
    value === 'client' ||
    value === 'general' ||
    value === 'folder'
  ) {
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

export function clientDivisionProjectFromUnified(
  project: UnifiedCompanyProject
): ClientDivisionProject {
  return {
    name: project.name,
    hubProjectId: project.hubProjectId,
    launchpadProjectId: project.launchpadProjectId,
    canonicalKey: canonicalKeyForUnified(project),
  };
}

export function clientDivisionFromProjects(
  clientName: string,
  projects: UnifiedCompanyProject[]
): ActiveDivisionClient {
  const trimmed = clientName.trim();
  return {
    kind: 'client',
    canonicalKey: clientCanonicalKey(trimmed),
    clientName: trimmed,
    projects: projects.map(clientDivisionProjectFromUnified),
  };
}

export function serializeClientDivisionProjects(projects: ClientDivisionProject[]): string {
  return JSON.stringify(projects);
}

export function parseClientDivisionProjects(
  raw: string | null | undefined
): ClientDivisionProject[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ClientDivisionProject[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const name = parseOptionalString(rec.name);
      const hubProjectId = parseOptionalString(rec.hubProjectId);
      const launchpadProjectId = parseOptionalNumber(rec.launchpadProjectId);
      const canonicalKey =
        parseOptionalString(rec.canonicalKey) ||
        (hubProjectId
          ? hubCanonicalKey(hubProjectId)
          : launchpadProjectId != null
            ? launchpadCanonicalKey(launchpadProjectId)
            : null);
      if (!name || !canonicalKey) continue;
      out.push({
        name,
        canonicalKey,
        ...(hubProjectId ? { hubProjectId } : {}),
        ...(launchpadProjectId != null ? { launchpadProjectId } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function emptyDivisionFields(division: WorkspaceDivisionKind = 'general'): SessionDivisionFields {
  return {
    division,
    hubProjectId: null,
    hubProjectName: null,
    launchpadProjectId: null,
    launchpadProjectName: null,
    folderId: null,
    folderName: null,
    canonicalKey: null,
    clientName: null,
    clientProjectIds: null,
  };
}

/** Hub + LaunchPad project ids allowed for project/client division MCP scoping. */
export function resolveProjectAllowlist(
  session: Partial<SessionDivisionFields> | null | undefined
): { hubIds: Set<string>; launchpadIds: Set<number> } | null {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division === 'project') {
    const hubIds = new Set<string>();
    const launchpadIds = new Set<number>();
    if (normalized.hubProjectId) hubIds.add(normalized.hubProjectId);
    if (normalized.launchpadProjectId != null) launchpadIds.add(normalized.launchpadProjectId);
    if (hubIds.size === 0 && launchpadIds.size === 0) return null;
    return { hubIds, launchpadIds };
  }
  if (normalized.division === 'client') {
    const projects = parseClientDivisionProjects(normalized.clientProjectIds);
    if (!projects.length) return null;
    const hubIds = new Set<string>();
    const launchpadIds = new Set<number>();
    for (const project of projects) {
      if (project.hubProjectId) hubIds.add(project.hubProjectId);
      if (project.launchpadProjectId != null) launchpadIds.add(project.launchpadProjectId);
    }
    if (hubIds.size === 0 && launchpadIds.size === 0) return null;
    return { hubIds, launchpadIds };
  }
  return null;
}

/** Catalog snapshot for validating session division fields against user allocations. */
export interface DivisionValidationCatalog {
  projects: UnifiedCompanyProject[];
  folderIds: Set<string>;
}

export type DivisionCatalogMatchResult =
  | { valid: true }
  | { valid: false; reason: string };

function catalogMaps(projects: UnifiedCompanyProject[]): {
  byHubId: Map<string, UnifiedCompanyProject>;
  byLaunchpadId: Map<number, UnifiedCompanyProject>;
  byCanonicalKey: Map<string, UnifiedCompanyProject>;
} {
  const byHubId = new Map<string, UnifiedCompanyProject>();
  const byLaunchpadId = new Map<number, UnifiedCompanyProject>();
  const byCanonicalKey = new Map<string, UnifiedCompanyProject>();
  for (const project of projects) {
    const key = canonicalKeyForUnified(project);
    byCanonicalKey.set(key, project);
    if (project.hubProjectId?.trim()) {
      byHubId.set(project.hubProjectId.trim(), project);
    }
    if (project.launchpadProjectId != null && Number.isFinite(project.launchpadProjectId)) {
      byLaunchpadId.set(project.launchpadProjectId, project);
    }
  }
  return { byHubId, byLaunchpadId, byCanonicalKey };
}

/**
 * Pure check: do session division fields match the user's allocated project/folder catalog?
 * general/hub divisions always pass. Invalid shapes should be caught by normalizeSessionDivision first.
 */
export function divisionFieldsMatchCatalog(
  input: Partial<SessionDivisionFields> | null | undefined,
  catalog: DivisionValidationCatalog
): DivisionCatalogMatchResult {
  const normalized = normalizeSessionDivision(input);
  const { division } = normalized;

  if (division === 'general' || division === 'hub') {
    return { valid: true };
  }

  if (division === 'folder') {
    const folderId = normalized.folderId?.trim();
    if (!folderId || !catalog.folderIds.has(folderId)) {
      return { valid: false, reason: 'folder not owned by user' };
    }
    return { valid: true };
  }

  const { byHubId, byLaunchpadId, byCanonicalKey } = catalogMaps(catalog.projects);

  if (division === 'project') {
    const hubId = normalized.hubProjectId?.trim() || null;
    const lpId = normalized.launchpadProjectId;
    if (!hubId && lpId == null) {
      return { valid: false, reason: 'project division missing ids' };
    }
    if (hubId && !byHubId.has(hubId)) {
      return { valid: false, reason: 'hub project not allocated' };
    }
    if (lpId != null && !byLaunchpadId.has(lpId)) {
      return { valid: false, reason: 'launchpad project not allocated' };
    }
    if (hubId && lpId != null) {
      const hubProject = byHubId.get(hubId);
      const lpProject = byLaunchpadId.get(lpId);
      if (
        hubProject &&
        lpProject &&
        canonicalKeyForUnified(hubProject) !== canonicalKeyForUnified(lpProject)
      ) {
        return { valid: false, reason: 'hub and launchpad ids refer to different projects' };
      }
    }
    const canonical = normalized.canonicalKey?.trim();
    if (canonical && !byCanonicalKey.has(canonical)) {
      return { valid: false, reason: 'canonical project key not in catalog' };
    }
    return { valid: true };
  }

  if (division === 'client') {
    const clientName = normalized.clientName?.trim();
    if (!clientName) {
      return { valid: false, reason: 'client division missing client name' };
    }
    const expectedKey = clientCanonicalKey(clientName);
    if (normalized.canonicalKey?.trim() && normalized.canonicalKey.trim() !== expectedKey) {
      return { valid: false, reason: 'client canonical key mismatch' };
    }
    const clientProjects = parseClientDivisionProjects(normalized.clientProjectIds);
    if (!clientProjects.length) {
      return { valid: false, reason: 'client division missing projects' };
    }
    const groups = groupUnifiedProjectsByClient(catalog.projects);
    const group = groups.find((g) => g.canonicalKey === expectedKey);
    if (!group) {
      return { valid: false, reason: 'client not in allocated catalog' };
    }
    const groupKeys = new Set(group.projects.map((p) => canonicalKeyForUnified(p)));
    const groupHubIds = new Set(
      group.projects.map((p) => p.hubProjectId?.trim()).filter(Boolean) as string[]
    );
    const groupLpIds = new Set(
      group.projects
        .map((p) => p.launchpadProjectId)
        .filter((id): id is number => id != null && Number.isFinite(id))
    );
    for (const entry of clientProjects) {
      if (groupKeys.has(entry.canonicalKey)) continue;
      if (entry.hubProjectId?.trim() && groupHubIds.has(entry.hubProjectId.trim())) continue;
      if (
        entry.launchpadProjectId != null &&
        Number.isFinite(entry.launchpadProjectId) &&
        groupLpIds.has(entry.launchpadProjectId)
      ) {
        continue;
      }
      return { valid: false, reason: `client project not allocated: ${entry.name}` };
    }
    return { valid: true };
  }

  return { valid: true };
}

export function normalizeSessionDivision(
  input?: Partial<SessionDivisionFields> | null
): SessionDivisionFields {
  const division = parseDivisionKind(input?.division);

  if (division === 'folder') {
    const folderId = parseOptionalString(input?.folderId);
    const folderName = parseOptionalString(input?.folderName);
    if (!folderId) {
      return emptyDivisionFields('general');
    }
    return {
      ...emptyDivisionFields('folder'),
      folderId,
      folderName: folderName || folderId,
    };
  }

  if (division === 'client') {
    const clientName = parseOptionalString(input?.clientName);
    const projects = parseClientDivisionProjects(input?.clientProjectIds ?? null);
    if (!clientName || !projects.length) {
      console.warn(
        '[WorkspaceDivision] Client division demoted to general — missing clientName or projects',
        { clientName: clientName ?? null }
      );
      return emptyDivisionFields('general');
    }
    const canonicalKey =
      parseOptionalString(input?.canonicalKey) || clientCanonicalKey(clientName);
    return {
      ...emptyDivisionFields('client'),
      clientName,
      clientProjectIds: serializeClientDivisionProjects(projects),
      canonicalKey,
    };
  }

  if (division === 'project') {
    const hubProjectId = parseOptionalString(input?.hubProjectId);
    const hubProjectName = parseOptionalString(input?.hubProjectName);
    const launchpadProjectId = parseOptionalNumber(input?.launchpadProjectId);
    const launchpadProjectName = parseOptionalString(input?.launchpadProjectName);

    if (!hubProjectId && launchpadProjectId == null) {
      console.warn(
        '[WorkspaceDivision] Project division demoted to general — missing hubProjectId and launchpadProjectId',
        {
          hubProjectName: hubProjectName ?? input?.hubProjectName ?? null,
          canonicalKey: input?.canonicalKey ?? null,
        }
      );
      return emptyDivisionFields('general');
    }

    const canonicalKey =
      parseOptionalString(input?.canonicalKey) ||
      (hubProjectId
        ? hubCanonicalKey(hubProjectId)
        : launchpadCanonicalKey(launchpadProjectId as number));

    return {
      ...emptyDivisionFields('project'),
      hubProjectId,
      hubProjectName: hubProjectName || hubProjectId,
      launchpadProjectId,
      launchpadProjectName:
        launchpadProjectName || (launchpadProjectId != null ? String(launchpadProjectId) : null),
      canonicalKey,
    };
  }

  if (division === 'hub') {
    return emptyDivisionFields('hub');
  }

  return emptyDivisionFields('general');
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
  if (normalized.division === 'client' && normalized.clientName) {
    return `vecos://client/${clientCanonicalKey(normalized.clientName).replace(/^client:/, '')}`;
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
  if (normalized.division === 'client' && normalized.clientName) {
    return {
      kind: 'client',
      canonicalKey: normalized.canonicalKey || clientCanonicalKey(normalized.clientName),
      clientName: normalized.clientName,
      projects: parseClientDivisionProjects(normalized.clientProjectIds),
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
  if (active.kind === 'client') {
    if (normalized.division !== 'client') return false;
    if (
      active.canonicalKey &&
      normalized.canonicalKey &&
      active.canonicalKey === normalized.canonicalKey
    ) {
      return true;
    }
    return (
      Boolean(active.clientName) &&
      Boolean(normalized.clientName) &&
      active.clientName!.trim().toLowerCase() === normalized.clientName!.trim().toLowerCase()
    );
  }
  if (active.kind === 'project') {
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
  if (active.kind === 'client') {
    return active.clientName || 'Client';
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
  if (kind === 'client') {
    const p = parsed as {
      clientName?: unknown;
      canonicalKey?: unknown;
      projects?: unknown;
    };
    const clientName = parseOptionalString(p.clientName);
    const projectsRaw = Array.isArray(p.projects) ? p.projects : [];
    const projects: ClientDivisionProject[] = [];
    for (const item of projectsRaw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const name = parseOptionalString(rec.name);
      const hubProjectId = parseOptionalString(rec.hubProjectId);
      const launchpadProjectId = parseOptionalNumber(rec.launchpadProjectId);
      const canonicalKey =
        parseOptionalString(rec.canonicalKey) ||
        (hubProjectId
          ? hubCanonicalKey(hubProjectId)
          : launchpadProjectId != null
            ? launchpadCanonicalKey(launchpadProjectId)
            : null);
      if (!name || !canonicalKey) continue;
      projects.push({
        name,
        canonicalKey,
        ...(hubProjectId ? { hubProjectId } : {}),
        ...(launchpadProjectId != null ? { launchpadProjectId } : {}),
      });
    }
    if (!clientName || !projects.length) {
      return null;
    }
    return {
      kind: 'client',
      canonicalKey: parseOptionalString(p.canonicalKey) || clientCanonicalKey(clientName),
      clientName,
      projects,
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

/**
 * Per-turn user-prompt block for client-scoped chats spanning multiple projects.
 */
export function buildDivisionActiveClientContext(
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const normalized = normalizeSessionDivision(session);
  if (normalized.division !== 'client' || !normalized.clientName) {
    return '';
  }
  const projects = parseClientDivisionProjects(normalized.clientProjectIds);
  if (!projects.length) {
    return '';
  }

  const lines = [
    '<active_client_context>',
    `SELECTED CLIENT (default subject of this chat): "${normalized.clientName}".`,
    'The user chose this client workspace. All delivery projects for this client are in scope.',
    'Treat project-related questions as about THIS client unless they clearly name a different client (then refuse / switch workspace).',
    'When the user does not name a specific project, answer at client level or pick the best-matching project from the list below.',
    'If ambiguous among this client\'s projects only, ask which project they mean — do not list unrelated company projects.',
    '',
    'Projects under this client:',
  ];
  for (const project of projects) {
    const idBits: string[] = [];
    if (project.hubProjectId) idBits.push(`hub id ${project.hubProjectId}`);
    if (project.launchpadProjectId != null) idBits.push(`launchpad id ${project.launchpadProjectId}`);
    lines.push(`- "${project.name}"${idBits.length ? ` (${idBits.join(', ')})` : ''}`);
  }
  lines.push(
    'When tools accept project id filters, pass the matching id from the list above.',
    'For client-wide questions (status across projects, staffing, risks), query each relevant project or use client-level search terms.',
    '</active_client_context>'
  );
  return lines.join('\n');
}

function projectDivisionHardRules(name: string): string[] {
  return [
    'DEFAULT SUBJECT: when the user does not name a project, assume they mean this project. Use its name and ids in tool calls/searches. Do not ask which project.',
    'MANDATORY SKILL: rnd-launchpad-mcp-sdlc is required in Project workspace. Follow that skill for all LaunchPad delivery (releases, implement, preview, QA, lock/seed). Load it from available_skills (Read its skill path) before delivery work — do not skip it.',
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

  if (normalized.division === 'client' && normalized.clientName) {
    const projects = parseClientDivisionProjects(normalized.clientProjectIds);
    const projectNames = projects.map((p) => `"${p.name}"`).join(', ');
    return [
      '<workspace_division>',
      `You are locked to client "${normalized.clientName}" spanning ${projects.length} project(s): ${projectNames}.`,
      'DEFAULT SUBJECT: when the user does not name a client or project, assume they mean this client and its listed projects.',
      'MANDATORY SKILL: rnd-launchpad-mcp-sdlc is required for LaunchPad delivery work in Client workspace. Load it before delivery tasks.',
      'HARD RULES — these override general "start doing it" behavior when the request is out of scope:',
      `IN SCOPE: delivery, Hub data, Launchpad/Pulse/Jira/comms for "${normalized.clientName}" and its projects only. Use hub/launchpad ids from the active client context.`,
      'OUT OF SCOPE (REFUSE): personal use; general company Q&A unrelated to this client; other clients or their projects; Hub-only HR unless staffing/allocations for THIS client\'s projects.',
      'On refuse: say "Incorrect use. This will be reported." then tell the user to switch to General, Client, or Project workspace in the sidebar.',
      'Never query, summarize, or compare data for other clients. If a tool returns data outside this client\'s projects, ignore out-of-scope rows.',
      'If the user names another client or an unrelated project, refuse and tell them to switch workspace.',
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
 * All divisions may use any cloud provider when Hub allows the model.
 * OpenRouter still requires the user's own API key (BYOK) at the picker / run layer.
 * When division is omitted (background jobs / one-shots without a session), pass through.
 */
export function isProviderAllowedInDivision(
  provider: string | undefined | null,
  _session: Partial<SessionDivisionFields> | null | undefined
): boolean {
  if (!provider) return false;
  return true;
}

export function filterModelsForDivision<T extends { provider: string }>(
  models: T[],
  _session: Partial<SessionDivisionFields> | null | undefined
): T[] {
  return models;
}

/** @deprecated General/Folder are no longer OpenRouter-only; kept for older call sites. */
export function generalWorkspaceOpenRouterOnlyMessage(): string {
  return 'OpenRouter models require your own API key in Settings → General. York-managed Claude, GPT, and Gemini use the York proxy when allowed by Hub AI Governance.';
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
  if (active.kind === 'client') {
    return {
      division: 'client',
      clientName: active.clientName,
      clientProjectIds: serializeClientDivisionProjects(active.projects),
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

/** IPC/session.create payload from the active workspace division. */
export function divisionPayloadFromActiveDivision(
  active: ActiveDivision | null
): Partial<SessionDivisionFields> & { division: WorkspaceDivisionKind } {
  if (!active) return { division: 'general' };
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
  if (active.kind === 'client') {
    return {
      division: 'client',
      clientName: active.clientName,
      clientProjectIds: serializeClientDivisionProjects(active.projects),
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
