/**
 * LaunchPad project list via REST (same auth as LaunchPad MCP / web).
 * Base URL: LAUNCHPAD_API_URL, or strip /mcp from launchpadMcpUrl.
 */
import { authConfig } from '../../shared/auth-config';
import {
  parseLaunchPadProjectsPayload,
  type LaunchPadProjectListItem,
} from '../../shared/unified-company-projects';
import { ensureAuthenticatedSession } from '../auth/session';
import { log, logWarn } from '../utils/logger';

const CACHE_TTL_MS = 5 * 60 * 1000;

type FetchFn = typeof fetch;

export class LaunchPadProjectsError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'LaunchPadProjectsError';
    this.status = status;
  }
}

interface CacheEntry {
  projects: LaunchPadProjectListItem[];
  fetchedAt: number;
  email: string;
}

let cache: CacheEntry | null = null;

export function clearLaunchPadProjectsCache(): void {
  cache = null;
}

/** REST origin for LaunchPad (not MCP path). */
export function resolveLaunchPadApiBaseUrl(): string {
  const explicit =
    (typeof process !== 'undefined' &&
      (process.env.LAUNCHPAD_API_URL || process.env.VITE_LAUNCHPAD_API_URL)?.trim()) ||
    '';
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }
  const mcp = authConfig.launchpadMcpUrl.replace(/\/$/, '');
  if (mcp.endsWith('/mcp')) {
    return mcp.slice(0, -'/mcp'.length);
  }
  try {
    const u = new URL(mcp);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://launchpad.yorkdevs.link';
  }
}

async function hubGetJson(
  url: string,
  token: string,
  fetchFn: FetchFn
): Promise<{ ok: boolean; status: number; json: unknown }> {
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

export async function fetchLaunchPadProjectsForUser(input: {
  token: string;
  alternateToken?: string | null;
  fetchFn?: FetchFn;
  baseUrl?: string;
}): Promise<LaunchPadProjectListItem[]> {
  const fetchFn = input.fetchFn ?? fetch;
  const base = (input.baseUrl || resolveLaunchPadApiBaseUrl()).replace(/\/$/, '');
  const url = `${base}/api/projects`;
  const tokens = [input.token, input.alternateToken].filter(
    (t): t is string => typeof t === 'string' && Boolean(t.trim())
  );
  const uniqueTokens = [...new Set(tokens.map((t) => t.trim()))];

  let lastStatus = 0;
  for (const token of uniqueTokens) {
    const result = await hubGetJson(url, token, fetchFn);
    lastStatus = result.status;
    if (result.ok) {
      return parseLaunchPadProjectsPayload(result.json);
    }
    if (result.status !== 401 && result.status !== 403) {
      break;
    }
  }

  throw new LaunchPadProjectsError(
    lastStatus || 502,
    lastStatus === 401 || lastStatus === 403
      ? 'LaunchPad rejected auth for project list'
      : 'Failed to load LaunchPad projects'
  );
}

export async function listLaunchPadProjects(options?: {
  fetchFn?: FetchFn;
  forceRefresh?: boolean;
}): Promise<LaunchPadProjectListItem[]> {
  const fetchFn = options?.fetchFn ?? fetch;
  const session = await ensureAuthenticatedSession();
  const accessToken = (session.accessToken || '').trim();
  const idToken = (session.idToken || '').trim();
  // Prefer id token for LaunchPad (same as MCP auth)
  const primary = idToken || accessToken;
  const alternate = primary === idToken ? accessToken || null : idToken || null;
  const email = (session.user?.email || 'unknown').toString().trim().toLowerCase();

  if (
    !options?.forceRefresh &&
    cache &&
    cache.email === email &&
    Date.now() - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return cache.projects;
  }

  try {
    const projects = await fetchLaunchPadProjectsForUser({
      token: primary,
      alternateToken: alternate && alternate !== primary ? alternate : null,
      fetchFn,
    });
    cache = { projects, fetchedAt: Date.now(), email };
    log(
      '[LaunchPadProjects] Loaded',
      projects.length,
      'projects for',
      email,
      `@ ${resolveLaunchPadApiBaseUrl()}`
    );
    return projects;
  } catch (error) {
    logWarn('[LaunchPadProjects] list failed:', error);
    throw error;
  }
}
