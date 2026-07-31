/**
 * Hub allocated projects for the signed-in user.
 *
 * Uses Hub Nest user APIs (Cognito access JWT) — not /api/external/v2
 * (those are M2M / x-api-key only and reject Cognito with 401).
 *
 * Primary: GET /api/users/:email/allocated-projects
 * Fallback: GET /api/projects/external/list (roles + allocations)
 */
import { authConfig } from '../../shared/auth-config';
import type { AllocatedHubProject } from '../../shared/workspace-division';
import { ensureAuthenticatedSession } from '../auth/session';
import { log, logWarn } from '../utils/logger';

const CACHE_TTL_MS = 5 * 60 * 1000;

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

let cache: CacheEntry | null = null;

export function clearHubAllocationsCache(): void {
  cache = null;
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
  if (nested && Array.isArray(nested.data)) {
    return nested.data;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
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
  const id =
    stringField(record, 'id', 'projectId', 'hubProjectId', 'clientProjectId') ||
    (nested ? stringField(nested, 'id', 'projectId', 'hubProjectId') : null);
  // Prefer explicit `name` (EIP). Hub allocated-projects uses `title` as project name.
  const hasExplicitName = Boolean(stringField(record, 'name', 'projectName', 'hubProjectName'));
  const name =
    stringField(record, 'name', 'projectName', 'hubProjectName') ||
    stringField(record, 'title') ||
    (nested ? stringField(nested, 'name', 'projectName', 'title') : null);
  if (!id || !name) {
    return null;
  }
  const hours = numberField(record, 'hours', 'allocatedHours', 'hours_per_week');
  const title = hasExplicitName
    ? stringField(record, 'title', 'role', 'allocationTitle') || undefined
    : stringField(record, 'role', 'allocationTitle') || undefined;
  return {
    id,
    name,
    ...(hours !== undefined ? { hours } : {}),
    ...(title ? { title } : {}),
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

/** Parse GET /api/users/:email/allocated-projects envelope. */
export function parseUserAllocatedProjects(payload: unknown): AllocatedHubProject[] {
  const projects = unwrapDataArray(payload)
    .map((row) => normalizeAllocatedProject(row))
    .filter((row): row is AllocatedHubProject => Boolean(row));
  return dedupeAllocatedProjects(projects);
}

/**
 * Parse GET /api/projects/external/list (projects where user is role-holder or allocated).
 * Also accepts legacy clients/with-allocations shapes for tests.
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

const PROJECTS_EXTERNAL_LIST = '/api/projects/external/list';

/** Fetch + parse allocated projects (testable without Electron session). */
export async function fetchAllocatedProjectsForUser(input: {
  token: string;
  email: string;
  alternateToken?: string | null;
  fetchFn?: FetchFn;
}): Promise<AllocatedHubProject[]> {
  const fetchFn = input.fetchFn ?? fetch;
  const { token, email, alternateToken = null } = input;
  const path = allocatedProjectsPath(email);

  let primary = await hubGet(path, token, fetchFn);
  if ((!primary.ok || primary.status === 401) && alternateToken) {
    logWarn('[HubAllocations] allocated-projects failed with primary token — retrying alternate');
    primary = await hubGet(path, alternateToken, fetchFn);
  }

  if (primary.ok && isSuccessEnvelope(primary.json)) {
    return parseUserAllocatedProjects(primary.json);
  }

  if (primary.status === 401) {
    throw new HubAllocationsError(
      401,
      `Hub rejected Cognito access token for ${path} (401). Try signing out and back in.`
    );
  }

  logWarn(
    '[HubAllocations] allocated-projects failed:',
    primary.status,
    '— trying /api/projects/external/list'
  );

  let fallback = await hubGet(PROJECTS_EXTERNAL_LIST, token, fetchFn);
  if ((!fallback.ok || fallback.status === 401) && alternateToken) {
    fallback = await hubGet(PROJECTS_EXTERNAL_LIST, alternateToken, fetchFn);
  }

  if (!fallback.ok || !isSuccessEnvelope(fallback.json)) {
    throw new HubAllocationsError(
      fallback.status || primary.status || 502,
      'Failed to load Hub project allocations'
    );
  }

  return parseClientsWithAllocations(fallback.json);
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
  });
  cache = { projects, fetchedAt: Date.now(), email: email.toLowerCase() };
  log(
    '[HubAllocations] Loaded',
    projects.length,
    'projects via /api/users/.../allocated-projects for',
    email,
    `@ ${authConfig.hubApiUrl}`
  );
  return projects;
}
