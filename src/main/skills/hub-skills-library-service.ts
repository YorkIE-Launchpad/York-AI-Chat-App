import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import extract from 'extract-zip';
import { authConfig } from '../../shared/auth-config';
import type { Skill } from '../../renderer/types';
import { AuthRequiredError, ensureAuthenticatedSession } from '../auth/session';
import { logError, logWarn } from '../utils/logger';
import type { SkillsManager } from './skills-manager';

const HUB_SKILLS_CATALOG_MAX_PAGES = 25;
const DEFAULT_PAGE_LIMIT = 20;

export interface HubSkillCatalogEntry {
  id: string;
  title: string;
  description?: string;
  slug?: string;
}

export interface HubSkillsListMeta {
  page?: number;
  hasNext?: boolean;
  [key: string]: unknown;
}

export class HubSkillsLibraryError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HubSkillsLibraryError';
    this.status = status;
  }
}

export function normalizeAiSkillsListResponse(hubJson: unknown): {
  data: Record<string, unknown>[];
  meta: HubSkillsListMeta;
} {
  const root = hubJson && typeof hubJson === 'object' ? (hubJson as Record<string, unknown>) : {};
  const envelope =
    root.data != null && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;
  const inner =
    envelope.data != null && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : envelope;
  const rows = Array.isArray(inner.data)
    ? (inner.data as Record<string, unknown>[])
    : Array.isArray(inner)
      ? (inner as Record<string, unknown>[])
      : Array.isArray(envelope)
        ? (envelope as Record<string, unknown>[])
        : [];
  const meta =
    inner.meta && typeof inner.meta === 'object'
      ? (inner.meta as HubSkillsListMeta)
      : envelope.meta && typeof envelope.meta === 'object'
        ? (envelope.meta as HubSkillsListMeta)
        : {};
  return { data: rows, meta };
}

export function mapHubSkillRows(rows: Record<string, unknown>[]): HubSkillCatalogEntry[] {
  const skills: HubSkillCatalogEntry[] = [];
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;
    const title =
      typeof row.title === 'string' && row.title.trim()
        ? row.title.trim()
        : typeof row.slug === 'string' && row.slug.trim()
          ? row.slug.trim()
          : id;
    const description =
      typeof row.description === 'string' && row.description.trim()
        ? row.description.trim()
        : undefined;
    const slug = typeof row.slug === 'string' && row.slug.trim() ? row.slug.trim() : undefined;
    skills.push({ id, title, description, slug });
  }
  return skills.sort((a, b) => a.title.localeCompare(b.title));
}

function requireHubApiBaseUrl(): string {
  const baseUrl = authConfig.hubApiUrl?.trim();
  if (!baseUrl) {
    throw new HubSkillsLibraryError(503, 'Hub API is not configured');
  }
  return baseUrl.replace(/\/+$/, '');
}

function normalizeAccessToken(accessToken: string | undefined): string {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!token) {
    throw new AuthRequiredError('Hub access token required');
  }
  return token;
}

function normalizeSkillId(skillId: string): string {
  const id = typeof skillId === 'string' ? skillId.trim() : '';
  if (!id) {
    throw new HubSkillsLibraryError(400, 'Skill id is required');
  }
  return id;
}

async function mapHubError(response: Response): Promise<never> {
  if (response.status === 401 || response.status === 403) {
    throw new AuthRequiredError('Sign in again');
  }
  if (response.status === 404) {
    throw new HubSkillsLibraryError(404, 'Skill not found');
  }
  let message = `Hub API request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body?.message === 'string' && body.message.trim()) {
      message = body.message.trim();
    }
  } catch {
    // keep default message
  }
  throw new HubSkillsLibraryError(response.status >= 500 ? 503 : response.status, message);
}

export async function listAiSkills(
  accessToken: string,
  opts: { page?: number; limit?: number; tab?: string } = {},
  fetchFn: typeof fetch = fetch
): Promise<{ data: Record<string, unknown>[]; meta: HubSkillsListMeta }> {
  const baseUrl = requireHubApiBaseUrl();
  const token = normalizeAccessToken(accessToken);
  const page = Number(opts.page) > 0 ? Number(opts.page) : 1;
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_PAGE_LIMIT;
  const tab = typeof opts.tab === 'string' && opts.tab.trim() ? opts.tab.trim() : 'public';

  const url = new URL(`${baseUrl}/api/ai-skills-library`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('tab', tab);

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    logError('[HubSkills] list fetch failed:', err);
    throw new HubSkillsLibraryError(503, 'Service unavailable');
  }

  if (!response.ok) {
    await mapHubError(response);
  }

  const hubJson = await response.json().catch(() => ({}));
  return normalizeAiSkillsListResponse(hubJson);
}

export async function listAllPublicHubSkills(
  accessToken: string,
  fetchFn: typeof fetch = fetch
): Promise<HubSkillCatalogEntry[]> {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!token) return [];

  const all: Record<string, unknown>[] = [];
  let page = 1;

  for (let i = 0; i < HUB_SKILLS_CATALOG_MAX_PAGES; i += 1) {
    const { data, meta } = await listAiSkills(
      token,
      { page, limit: DEFAULT_PAGE_LIMIT, tab: 'public' },
      fetchFn
    );
    all.push(...data);
    if (!meta?.hasNext) break;
    page += 1;
  }

  return mapHubSkillRows(all);
}

export async function downloadSkillZip(
  accessToken: string,
  skillId: string,
  opts: { context?: string } = {},
  fetchFn: typeof fetch = fetch
): Promise<Buffer> {
  const baseUrl = requireHubApiBaseUrl();
  const token = normalizeAccessToken(accessToken);
  const id = normalizeSkillId(skillId);
  const context =
    typeof opts.context === 'string' && opts.context.trim() ? opts.context.trim() : 'live';

  const url = new URL(`${baseUrl}/api/ai-skills-library/${encodeURIComponent(id)}/download-zip`);
  url.searchParams.set('context', context);

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    logError('[HubSkills] download fetch failed:', err);
    throw new HubSkillsLibraryError(503, 'Service unavailable');
  }

  if (!response.ok) {
    await mapHubError(response);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function resolveExtractedSkillRoot(
  extractDir: string,
  primaryFile = 'SKILL.md'
): Promise<string> {
  const fileName =
    typeof primaryFile === 'string' && primaryFile.trim() ? primaryFile.trim() : 'SKILL.md';

  const direct = path.join(extractDir, fileName);
  if (fs.existsSync(direct)) {
    return extractDir;
  }

  const entries = await fs.promises.readdir(extractDir);
  for (const entry of entries) {
    const entryPath = path.join(extractDir, entry);
    const stat = await fs.promises.stat(entryPath);
    if (!stat.isDirectory()) continue;
    const nested = path.join(entryPath, fileName);
    if (fs.existsSync(nested)) {
      return entryPath;
    }
  }

  throw new HubSkillsLibraryError(502, `Skill file ${fileName} not found in downloaded pack`);
}

async function withExtractedSkill<T>(
  accessToken: string,
  skillId: string,
  fn: (extractDir: string) => Promise<T>,
  fetchFn: typeof fetch = fetch
): Promise<T> {
  const zipBuffer = await downloadSkillZip(accessToken, skillId, {}, fetchFn);
  const tempRoot = path.join(os.tmpdir(), `hub-skill-${randomUUID()}`);
  const zipPath = path.join(tempRoot, 'skill.zip');
  const extractDir = path.join(tempRoot, 'extracted');

  await fs.promises.mkdir(tempRoot, { recursive: true });
  await fs.promises.writeFile(zipPath, zipBuffer);
  await fs.promises.mkdir(extractDir, { recursive: true });
  await extract(zipPath, { dir: extractDir });

  try {
    return await fn(extractDir);
  } finally {
    try {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    } catch (err) {
      logWarn('[HubSkills] temp cleanup failed:', err);
    }
  }
}

async function resolveHubAccessToken(): Promise<string> {
  const session = await ensureAuthenticatedSession();
  const accessToken = (session.accessToken || session.idToken || '').trim();
  if (!accessToken) {
    throw new AuthRequiredError('Sign in again');
  }
  return accessToken;
}

export class HubSkillsLibraryService {
  constructor(
    private readonly skillsManager: SkillsManager,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async listPublicSkills(): Promise<HubSkillCatalogEntry[]> {
    const accessToken = await resolveHubAccessToken();
    return listAllPublicHubSkills(accessToken, this.fetchFn);
  }

  async installSkill(skillId: string): Promise<Skill> {
    const id = normalizeSkillId(skillId);
    const accessToken = await resolveHubAccessToken();

    return withExtractedSkill(
      accessToken,
      id,
      async (extractDir) => {
        const packRoot = await resolveExtractedSkillRoot(extractDir);
        return this.skillsManager.installSkill(packRoot);
      },
      this.fetchFn
    );
  }
}
