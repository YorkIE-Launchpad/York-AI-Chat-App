/**
 * Hub allocated projects for the signed-in user.
 *
 * Uses Hub Nest user APIs (Cognito access JWT) — not /api/external/v2
 * (those are M2M / x-api-key only and reject Cognito with 401).
 *
 * Primary: GET /api/projects/list
 * Fallback: GET /api/users/:email/allocated-projects
 * Enrichment: GET /api/projects (client_name on full project rows)
 * After primary fails once (401/403/empty/non-ok), skip primary for 10m and always use fallback.
 */
import { authConfig } from '../../shared/auth-config';
import type { AllocatedHubProject } from '../../shared/workspace-division';
import { ensureAuthenticatedSession } from '../auth/session';
import { log, logWarn } from '../utils/logger';

const CACHE_TTL_MS = 5 * 60 * 1000;
const PRIMARY_SKIP_TTL_MS = 10 * 60 * 1000;

const PROJECTS_LIST = '/api/projects/list';
const PROJECTS_INDEX = '/api/projects';

type FetchFn = typeof fetch;

export class HubAllocationsError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HubAllocationsError';
    this.status = status;
  }
}

interface CacheEntry {
  projects: AllocatedHubProject[];
  fetchedAt: number;
  email: string;
}

/** Per-email: skip /api/projects/list until this timestamp. */
const primarySkipUntilByEmail = new Map<string, number>();

let cache: CacheEntry | null = null;

export function clearHubAllocationsCache(): void {
  cache = null;
  primarySkipUntilByEmail.clear();
}

/** Test helper — clear primary-skip state. */
export function clearPrimarySkipCache(): void {
  primarySkipUntilByEmail.clear();
}

/** Test helper — whether primary is currently skipped for an email. */
export function isPrimaryProjectsListSkipped(email: string, now = Date.now()): boolean {
  const until = primarySkipUntilByEmail.get(email.trim().toLowerCase());
  return typeof until === 'number' && now < until;
}

function markPrimarySkip(email: string, now = Date.now()): void {
  primarySkipUntilByEmail.set(email.trim().toLowerCase(), now + PRIMARY_SKIP_TTL_MS);
}

function clearPrimarySkip(email: string): void {
  primarySkipUntilByEmail.delete(email.trim().toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function numberField(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function unwrapDataArray(payload: unknown): unknown[] {
  const root = asRecord(payload) || {};
  if (Array.isArray(root.data)) {
    return root.data;
  }
  const nested = asRecord(root.data);
  if (nested) {
    if (Array.isArray(nested.data)) return nested.data;
    if (Array.isArray(nested.items)) return nested.items;
    if (Array.isArray(nested.projects)) return nested.projects;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

/** Hub project id keys — prefer project UUID fields over bare allocation `id`. */
const HUB_PROJECT_ID_KEYS = [
  'projectId',
  'hubProjectId',
  'clientProjectId',
  'project_uuid',
  'uuid',
  'id',
  '_id',
] as const;

function extractHubProjectId(
  record: Record<string, unknown>,
  nested: Record<string, unknown> | null
): string | null {
  return (
    stringField(record, ...HUB_PROJECT_ID_KEYS) ||
    (nested ? stringField(nested, ...HUB_PROJECT_ID_KEYS) : null)
  );
}

/** Parse client display name from Hub project / allocation rows. */
export function extractClientName(
  record: Record<string, unknown>,
  nested: Record<string, unknown> | null
): string | null {
  const direct =
    stringField(record, 'client_name', 'clientName') ||
    (nested ? stringField(nested, 'client_name', 'clientName') : null);
  if (direct) return direct;

  for (const container of [record, nested]) {
    if (!container) continue;
    const clientObj =
      asRecord(container.client) ||
      asRecord(container.clientInfo) ||
      asRecord(container.client_info);
    if (!clientObj) continue;
    const name =
      stringField(clientObj, 'name', 'client_name', 'clientName', 'title', 'displayName') ||
      stringField(clientObj, 'company_name', 'companyName');
    if (name) return name;
  }
  return null;
}

export function enrichAllocatedProjectsWithClientNames(
  projects: AllocatedHubProject[],
  clientNameByProjectId: Map<string, string>
): AllocatedHubProject[] {
  if (clientNameByProjectId.size === 0) return projects;
  return projects.map((project) => {
    if (project.clientName?.trim()) return project;
    const clientName = clientNameByProjectId.get(project.id);
    return clientName ? { ...project, clientName } : project;
  });
}

export function parseProjectClientNameIndex(payload: unknown): Map<string, string> {
  const byId = new Map<string, string>();
  for (const row of unwrapDataArray(payload)) {
    const record = asRecord(row);
    if (!record) continue;
    const nested =
      asRecord(record.project) ||
      asRecord(record.hubProject) ||
      asRecord(record.clientProject) ||
      null;
    const id = extractHubProjectId(record, nested);
    const clientName = extractClientName(record, nested);
    if (id && clientName) {
      byId.set(id, clientName);
    }
  }
  return byId;
}

async function fetchProjectClientNameIndex(input: {
  token: string;
  alternateToken: string | null;
  fetchFn: FetchFn;
}): Promise<Map<string, string>> {
  const result = await hubGetWithTokenRetry(
    PROJECTS_INDEX,
    input.token,
    input.alternateToken,
    input.fetchFn
  );
  if (!result.ok || !isSuccessEnvelope(result.json)) {
    return new Map();
  }
  return parseProjectClientNameIndex(result.json);
}

/** Normalize a Hub allocated-project / project-list row. */
export function normalizeAllocatedProject(row: unknown): AllocatedHubProject | null {
  const record = asRecord(row);
  if (!record) {
    return null;
  }
  const nested =
    asRecord(record.project) ||
    asRecord(record.hubProject) ||
    asRecord(record.clientProject) ||
    null;
  const id = extractHubProjectId(record, nested);
  // Prefer explicit `name` (EIP). Hub allocated-projects / list uses `title` as project name.
  const hasExplicitName = Boolean(stringField(record, 'name', 'projectName', 'hubProjectName'));
  const name =
    stringField(record, 'name', 'projectName', 'hubProjectName') ||
    stringField(record, 'title') ||
    (nested ? stringField(nested, 'name', 'projectName', 'title') : null);
  if (!id || !name) {
    const keys = Object.keys(record).slice(0, 12).join(', ');
    logWarn(
      `[HubAllocations] Dropped project row — missing ${!id ? 'id' : 'name'} (keys: ${keys || 'none'})`
    );
    return null;
  }
  const hours = numberField(record, 'hours', 'allocatedHours', 'hours_per_week');
  const title = hasExplicitName
    ? stringField(record, 'title', 'role', 'allocationTitle') || undefined
    : stringField(record, 'role', 'allocationTitle') || undefined;
  const clientName = extractClientName(record, nested) || undefined;
  return {
    id,
    name,
    ...(hours !== undefined ? { hours } : {}),
    ...(title ? { title } : {}),
    ...(clientName ? { clientName } : {}),
  };
}

export function dedupeAllocatedProjects(projects: AllocatedHubProject[]): AllocatedHubProject[] {
  const byId = new Map<string, AllocatedHubProject>();
  for (const project of projects) {
    if (!byId.has(project.id)) {
      byId.set(project.id, project);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse GET /api/projects/list or /api/users/:email/allocated-projects envelope. */
export function parseUserAllocatedProjects(payload: unknown): AllocatedHubProject[] {
  const projects = unwrapDataArray(payload)
    .map((row) => normalizeAllocatedProject(row))
    .filter((row): row is AllocatedHubProject => Boolean(row));
  return dedupeAllocatedProjects(projects);
}

/**
 * Parse GET /api/projects/external/list (legacy) and clients/with-allocations shapes for tests.
 */
export function parseClientsWithAllocations(payload: unknown): AllocatedHubProject[] {
  const root = asRecord(payload) || {};
  const data = asRecord(root.data) || root;
  const candidates: unknown[] = [];

  if (Array.isArray(data.clients)) {
    for (const client of data.clients) {
      const clientRec = asRecord(client);
      if (!clientRec) continue;
      const allocations =
        clientRec.allocations || clientRec.projects || clientRec.projectAllocations;
      if (Array.isArray(allocations)) {
        candidates.push(...allocations);
      } else {
        candidates.push(client);
      }
    }
  }
  if (Array.isArray(data.projects)) {
    candidates.push(...data.projects);
  }
  if (Array.isArray(data.allocations)) {
    candidates.push(...data.allocations);
  }
  candidates.push(...unwrapDataArray(payload));

  const projects = candidates
    .map((row) => normalizeAllocatedProject(row))
    .filter((row): row is AllocatedHubProject => Boolean(row));
  return dedupeAllocatedProjects(projects);
}

/** @deprecated Prefer parseUserAllocatedProjects — kept for EIP-shaped test fixtures. */
export function parseActiveUsersWithAllocations(
  payload: unknown,
  email: string
): AllocatedHubProject[] {
  const normalizedEmail = email.trim().toLowerCase();
  const root = asRecord(payload) || {};
  const data = asRecord(root.data) || root;
  const users = Array.isArray(data.users) ? data.users : [];
  const match = users.find((user) => {
    const rec = asRecord(user);
    if (!rec) return false;
    const userEmail = stringField(rec, 'email', 'Email', 'workEmail');
    return userEmail?.toLowerCase() === normalizedEmail;
  });
  if (!match) {
    return [];
  }
  const matchRec = asRecord(match)!;
  const allocations = Array.isArray(matchRec.allocations) ? matchRec.allocations : [];
  return dedupeAllocatedProjects(
    allocations
      .map((row) => normalizeAllocatedProject(row))
      .filter((row): row is AllocatedHubProject => Boolean(row))
  );
}

/** Cognito access token — Hub Nest JWT middleware expects token_use=access. */
async function resolveAccessToken(): Promise<{ token: string; email: string }> {
  const session = await ensureAuthenticatedSession();
  const accessToken = (session.accessToken || '').trim();
  const idToken = (session.idToken || '').trim();
  const token = accessToken || idToken;
  if (!token) {
    throw new HubAllocationsError(401, 'No Cognito token available');
  }
  const email = (session.user?.email || '').trim();
  if (!email) {
    throw new HubAllocationsError(401, 'Signed-in user email is required');
  }
  return { token, email };
}

async function hubGet(
  path: string,
  token: string,
  fetchFn: FetchFn
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const base = authConfig.hubApiUrl.replace(/\/$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

function isSuccessEnvelope(json: unknown): boolean {
  const root = asRecord(json);
  if (!root) return Array.isArray(json);
  if (root.success === false) return false;
  return true;
}

function allocatedProjectsPath(email: string): string {
  return `/api/users/${encodeURIComponent(email)}/allocated-projects`;
}

async function hubGetWithTokenRetry(
  path: string,
  token: string,
  alternateToken: string | null,
  fetchFn: FetchFn
): Promise<{ ok: boolean; status: number; json: unknown }> {
  let result = await hubGet(path, token, fetchFn);
  if ((!result.ok || result.status === 401 || result.status === 403) && alternateToken) {
    logWarn('[HubAllocations]', path, 'failed with primary token — retrying alternate');
    result = await hubGet(path, alternateToken, fetchFn);
  }
  return result;
}

async function fetchAllocatedProjectsFallback(input: {
  token: string;
  email: string;
  alternateToken: string | null;
  fetchFn: FetchFn;
}): Promise<AllocatedHubProject[]> {
  const path = allocatedProjectsPath(input.email);
  const result = await hubGetWithTokenRetry(path, input.token, input.alternateToken, input.fetchFn);

  if (result.ok && isSuccessEnvelope(result.json)) {
    return parseUserAllocatedProjects(result.json);
  }

  throw new HubAllocationsError(
    result.status || 502,
    result.status === 401
      ? `Hub rejected Cognito access token for ${path} (401). Try signing out and back in.`
      : 'Failed to load Hub project allocations'
  );
}

/**
 * Fetch + parse allocated projects (testable without Electron session).
 * Primary /api/projects/list; on fail/empty mark skip and use allocated-projects.
 */
export async function fetchAllocatedProjectsForUser(input: {
  token: string;
  email: string;
  alternateToken?: string | null;
  fetchFn?: FetchFn;
  /** When true, ignore primary-skip and try /api/projects/list again. */
  forcePrimary?: boolean;
}): Promise<AllocatedHubProject[]> {
  const fetchFn = input.fetchFn ?? fetch;
  const { token, email, alternateToken = null, forcePrimary = false } = input;
  const skipPrimary = !forcePrimary && isPrimaryProjectsListSkipped(email);
  const enrichInput = { token, alternateToken, fetchFn };

  if (!skipPrimary) {
    const primary = await hubGetWithTokenRetry(PROJECTS_LIST, token, alternateToken, fetchFn);
    if (primary.ok && isSuccessEnvelope(primary.json)) {
      const projects = parseUserAllocatedProjects(primary.json);
      if (projects.length > 0) {
        clearPrimarySkip(email);
        return enrichWithClientNames(projects, enrichInput);
      }
      logWarn('[HubAllocations] /api/projects/list returned 0 projects — using allocated-projects');
    } else {
      logWarn(
        '[HubAllocations] /api/projects/list failed:',
        primary.status,
        '— using allocated-projects'
      );
    }
    markPrimarySkip(email);
  } else {
    log('[HubAllocations] Skipping /api/projects/list (cached failure) — allocated-projects only');
  }

  const fallback = await fetchAllocatedProjectsFallback({
    token,
    email,
    alternateToken,
    fetchFn,
  });
  return enrichWithClientNames(fallback, enrichInput);
}

async function fetchProjectClientNameById(input: {
  projectId: string;
  token: string;
  alternateToken: string | null;
  fetchFn: FetchFn;
}): Promise<string | null> {
  const path = `/api/projects/${encodeURIComponent(input.projectId)}`;
  const result = await hubGetWithTokenRetry(
    path,
    input.token,
    input.alternateToken,
    input.fetchFn
  );
  if (!result.ok || !isSuccessEnvelope(result.json)) {
    return null;
  }
  const root = asRecord(result.json);
  const data = asRecord(root?.data) || root;
  if (!data) return null;
  const nested =
    asRecord(data.project) ||
    asRecord(data.hubProject) ||
    asRecord(data.clientProject) ||
    null;
  return extractClientName(data, nested);
}

async function enrichWithClientNames(
  projects: AllocatedHubProject[],
  input: {
    token: string;
    alternateToken: string | null;
    fetchFn: FetchFn;
  }
): Promise<AllocatedHubProject[]> {
  if (!projects.length) return projects;
  if (projects.every((p) => p.clientName?.trim())) return projects;
  try {
    const clientNameById = await fetchProjectClientNameIndex(input);
    const missing = projects.filter((p) => !p.clientName?.trim() && !clientNameById.has(p.id));
    if (missing.length > 0) {
      const perProject = await Promise.all(
        missing.map(async (project) => {
          const clientName = await fetchProjectClientNameById({
            projectId: project.id,
            ...input,
          });
          return clientName ? ([project.id, clientName] as const) : null;
        })
      );
      for (const entry of perProject) {
        if (entry) clientNameById.set(entry[0], entry[1]);
      }
      const viaDetail = perProject.filter(Boolean).length;
      if (viaDetail > 0) {
        log(
          '[HubAllocations] Enriched',
          viaDetail,
          'projects with client_name from GET /api/projects/:id'
        );
      }
    }
    if (clientNameById.size === 0) {
      logWarn(
        '[HubAllocations] No client_name found for',
        projects.length,
        'allocated project(s) — Client workspace picker will be empty'
      );
      return projects;
    }
    const enriched = enrichAllocatedProjectsWithClientNames(projects, clientNameById);
    const added =
      enriched.filter((p) => p.clientName).length - projects.filter((p) => p.clientName).length;
    if (added > 0) {
      log('[HubAllocations] Enriched', added, 'projects with client_name from', PROJECTS_INDEX);
    }
    return enriched;
  } catch (error) {
    logWarn('[HubAllocations] client_name enrichment failed:', error);
    return projects;
  }
}

export async function listAllocatedProjects(options?: {
  fetchFn?: FetchFn;
  forceRefresh?: boolean;
}): Promise<AllocatedHubProject[]> {
  const fetchFn = options?.fetchFn ?? fetch;
  const session = await ensureAuthenticatedSession();
  const accessToken = (session.accessToken || '').trim();
  const idToken = (session.idToken || '').trim();
  const { token, email } = await resolveAccessToken();
  const alternateToken =
    accessToken && idToken && accessToken !== idToken
      ? token === accessToken
        ? idToken
        : accessToken
      : null;

  if (options?.forceRefresh) {
    clearPrimarySkip(email);
  }

  if (
    !options?.forceRefresh &&
    cache &&
    cache.email === email.toLowerCase() &&
    Date.now() - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return cache.projects;
  }

  const projects = await fetchAllocatedProjectsForUser({
    token,
    alternateToken,
    email,
    fetchFn,
    forcePrimary: Boolean(options?.forceRefresh),
  });
  cache = { projects, fetchedAt: Date.now(), email: email.toLowerCase() };
  log(
    '[HubAllocations] Loaded',
    projects.length,
    'projects for',
    email,
    `@ ${authConfig.hubApiUrl}`
  );
  return projects;
}
