/**
 * Hub AI Governance — org model picker + usage ingest.
 *
 * GET  /api/ai-governance/models
 * POST /api/ai-governance/usage
 * Auth: Cognito access JWT (same as other Hub Nest user APIs).
 *
 * Pure payload helpers live in `shared/hub-governance-usage.ts` (MCP-safe).
 */
import { authConfig } from '../../shared/auth-config';
import {
  inferBackendCloudProviderForModelId,
  isBackendManagedProvider,
  type BackendModelInfo,
} from '../../shared/backend-config';
import {
  parseHubUserAiBudget,
  type HubUserAiBudgetSnapshot,
} from '../../shared/fe-budget-gate';
import {
  buildHubUsagePayloadFromPiUsage,
  extractVisionApiUsage,
  parseHubGovernanceUsageResponse,
  type BuildHubUsageInput,
  type HubGovernanceUsageIngestResult,
  type HubGovernanceUsagePayload,
} from '../../shared/hub-governance-usage';
import { ensureAuthenticatedSession } from '../auth/session';
import { log, logWarn } from '../utils/logger';

export type {
  BuildHubUsageInput,
  HubGovernanceUsageIngestResult,
  HubGovernanceUsagePayload,
  HubUserAiBudgetSnapshot,
};
export { parseHubUserAiBudget };
export {
  buildHubUsagePayloadFromPiUsage,
  extractVisionApiUsage,
  parseHubGovernanceUsageResponse,
  reportHubUsageWithBearerToken,
  reportMcpVisionUsageViaEnv,
  HUB_USAGE_SOURCE,
  HUB_USAGE_FEATURE_DEFAULT,
  HUB_USAGE_PATH,
} from '../../shared/hub-governance-usage';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MODELS_PATH = '/api/ai-governance/models';
const USAGE_PATH = '/api/ai-governance/usage';

type FetchFn = typeof fetch;

export class HubAiGovernanceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HubAiGovernanceError';
    this.status = status;
  }
}

/** Grant row from GET /api/ai-governance/users/:email/allowed-models */
export interface HubAllowedAiModelGrant {
  modelId: string;
  workspaceTags: string[];
  source?: string;
  isFree?: boolean;
  hasBudget?: boolean;
}

/** Parsed GET /api/ai-governance/users/:email/allowed-models */
export interface HubUserAllowedAiModels {
  email: string;
  /**
   * With usable=true: true only when a FY ceiling is set and not over (ok/warning).
   * False when over or unset. Per-grant has_budget = is_free || this flag.
   */
  hasBudget: boolean;
  grants: HubAllowedAiModelGrant[];
  modelIds: string[];
}

interface ModelsCacheEntry {
  models: BackendModelInfo[];
  fetchedAt: number;
}

interface AllowedCacheEntry {
  email: string;
  data: HubUserAllowedAiModels;
  fetchedAt: number;
}

const modelsCache = new Map<string, ModelsCacheEntry>();
const allowedCacheMap = new Map<string, AllowedCacheEntry>();
let userBudgetCache: {
  email: string;
  data: HubUserAiBudgetSnapshot;
  fetchedAt: number;
} | null = null;

function modelsCacheKey(usable: boolean): string {
  return usable ? 'usable' : 'all';
}

function allowedCacheKey(email: string, usable: boolean): string {
  return `${email.toLowerCase()}::${modelsCacheKey(usable)}`;
}

export function clearHubGovernanceModelsCache(): void {
  modelsCache.clear();
  allowedCacheMap.clear();
  userBudgetCache = null;
}

function userAiBudgetPath(email: string): string {
  return `/api/users/${encodeURIComponent(email)}/ai-budget`;
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
  }
  return null;
}

function booleanField(row: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function isSuccessEnvelope(json: unknown): boolean {
  const root = asRecord(json);
  if (!root) return Array.isArray(json);
  if (root.success === false) return false;
  return true;
}

/**
 * Unwrap Hub `{ success, data: { models } }` (or bare `{ models }`) into BackendModelInfo[].
 * Skips rows with unknown providers.
 */
export function parseHubGovernanceModels(payload: unknown): BackendModelInfo[] {
  const root = asRecord(payload) || {};
  const data = asRecord(root.data) || root;
  const raw = Array.isArray(data.models) ? data.models : [];

  const models: BackendModelInfo[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const row = asRecord(entry);
    if (!row) continue;

    const id = stringField(row, 'id', 'model_id');
    const name = stringField(row, 'name') || id;
    const providerRaw = stringField(row, 'provider');
    if (!id || !providerRaw) continue;

    if (!isBackendManagedProvider(providerRaw)) {
      logWarn('[HubAiGovernance] Skipping model with unsupported provider:', providerRaw, id);
      continue;
    }

    const key = `${providerRaw}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isFree = booleanField(row, 'is_free', 'isFree');
    const isDefaultActive = booleanField(row, 'is_default_active', 'isDefaultActive');

    models.push({
      id,
      name: name || id,
      provider: providerRaw,
      ...(isFree !== undefined ? { isFree } : {}),
      ...(isDefaultActive !== undefined ? { isDefaultActive } : {}),
    });
  }

  return models;
}

/**
 * Parse GET /api/ai-governance/users/:email/allowed-models envelope.
 */
export function parseUserAllowedAiModels(payload: unknown): HubUserAllowedAiModels {
  const root = asRecord(payload) || {};
  const data = asRecord(root.data) || root;
  const email = stringField(data, 'email') || '';
  const hasBudget = booleanField(data, 'has_budget', 'hasBudget') ?? false;

  const grantsRaw = Array.isArray(data.grants) ? data.grants : [];
  const grants: HubAllowedAiModelGrant[] = [];
  for (const entry of grantsRaw) {
    const row = asRecord(entry);
    if (!row) continue;
    const modelId = stringField(row, 'model_id', 'modelId');
    if (!modelId) continue;
    const tagsRaw = row.workspace_tags ?? row.workspaceTags;
    const workspaceTags = Array.isArray(tagsRaw)
      ? tagsRaw.filter((t): t is string => typeof t === 'string' && Boolean(t.trim()))
      : [];
    grants.push({
      modelId,
      workspaceTags,
      source: stringField(row, 'source') || undefined,
      isFree: booleanField(row, 'is_free', 'isFree'),
      hasBudget: booleanField(row, 'has_budget', 'hasBudget'),
    });
  }

  const idsRaw = Array.isArray(data.model_ids)
    ? data.model_ids
    : Array.isArray(data.modelIds)
      ? data.modelIds
      : [];
  const modelIdsFromField = idsRaw.filter(
    (id): id is string => typeof id === 'string' && Boolean(id.trim())
  );
  const modelIds = [
    ...new Set([...modelIdsFromField, ...grants.map((g) => g.modelId)].filter(Boolean)),
  ];

  return { email, hasBudget, grants, modelIds };
}

function backendModelFromGrant(grant: HubAllowedAiModelGrant): BackendModelInfo | null {
  const provider = inferBackendCloudProviderForModelId(grant.modelId);
  if (!provider) return null;
  return {
    id: grant.modelId,
    name: grant.modelId,
    provider,
    ...(grant.isFree !== undefined ? { isFree: grant.isFree } : {}),
    ...(grant.hasBudget !== undefined ? { hasBudget: grant.hasBudget } : {}),
  };
}

/**
 * Intersect org catalog with user allowed-models.
 * Grant is_free / has_budget override catalog flags when present.
 * When root has_budget is false (over/unset), catalog is_free rows stay even if not granted.
 * Group/user grants missing from GET /models are still appended (provider inferred).
 */
export function joinCatalogWithAllowedModels(
  catalog: BackendModelInfo[],
  allowed: HubUserAllowedAiModels | null
): BackendModelInfo[] {
  if (!allowed) return catalog;

  const grantById = new Map(allowed.grants.map((g) => [g.modelId, g]));
  const allowedIds = new Set(
    [...allowed.modelIds, ...allowed.grants.map((g) => g.modelId)]
      .map((id) => id.trim())
      .filter(Boolean)
  );
  const includeCatalogFree = allowed.hasBudget === false;
  if (allowedIds.size === 0 && !includeCatalogFree) return [];

  const joined: BackendModelInfo[] = [];
  const seen = new Set<string>();

  for (const m of catalog) {
    if (!allowedIds.has(m.id) && !(includeCatalogFree && m.isFree === true)) continue;
    const grant = grantById.get(m.id);
    if (!grant) {
      joined.push(
        includeCatalogFree && m.isFree === true ? { ...m, hasBudget: true } : m
      );
    } else {
      joined.push({
        ...m,
        isFree: grant.isFree !== undefined ? grant.isFree : m.isFree,
        hasBudget: grant.hasBudget,
      });
    }
    seen.add(m.id);
  }

  for (const grant of allowed.grants) {
    if (seen.has(grant.modelId)) continue;
    const extra = backendModelFromGrant(grant);
    if (!extra) {
      logWarn(
        '[HubAiGovernance] Skipping granted model with unknown provider:',
        grant.modelId,
        grant.source || ''
      );
      continue;
    }
    joined.push(extra);
    seen.add(grant.modelId);
  }

  return joined;
}

async function resolveAccessToken(): Promise<{
  token: string;
  alternateToken: string | null;
  email: string;
}> {
  const session = await ensureAuthenticatedSession();
  const accessToken = (session.accessToken || '').trim();
  const idToken = (session.idToken || '').trim();
  const token = accessToken || idToken;
  if (!token) {
    throw new HubAiGovernanceError(401, 'No Cognito token available');
  }
  const email = (session.user?.email || '').trim();
  if (!email) {
    throw new HubAiGovernanceError(401, 'Signed-in user email is required');
  }
  const alternateToken =
    accessToken && idToken && accessToken !== idToken
      ? token === accessToken
        ? idToken
        : accessToken
      : null;
  return { token, alternateToken, email };
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
    signal: AbortSignal.timeout(8000),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

async function hubPost(
  path: string,
  token: string,
  body: unknown,
  fetchFn: FetchFn
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const base = authConfig.hubApiUrl.replace(/\/$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Fetch + parse org models (testable without Electron session).
 */
export async function fetchHubGovernanceModelsForToken(input: {
  token: string;
  alternateToken?: string | null;
  fetchFn?: FetchFn;
}): Promise<BackendModelInfo[]> {
  const fetchFn = input.fetchFn ?? fetch;
  let result = await hubGet(MODELS_PATH, input.token, fetchFn);

  if (
    (!result.ok || result.status === 401 || result.status === 403) &&
    input.alternateToken
  ) {
    logWarn('[HubAiGovernance]', MODELS_PATH, 'failed with primary token — retrying alternate');
    result = await hubGet(MODELS_PATH, input.alternateToken, fetchFn);
  }

  if (result.ok && isSuccessEnvelope(result.json)) {
    return parseHubGovernanceModels(result.json);
  }

  throw new HubAiGovernanceError(
    result.status || 502,
    result.status === 401
      ? `Hub rejected Cognito token for ${MODELS_PATH} (401). Try signing out and back in.`
      : result.status === 403
        ? `Hub denied access to ${MODELS_PATH} (403). Requires manage-ai-model-access.`
        : `Failed to load Hub AI governance models (${result.status || 'network'})`
  );
}

function allowedModelsPath(email: string, usable = true): string {
  const base = `/api/ai-governance/users/${encodeURIComponent(email)}/allowed-models`;
  return usable ? `${base}?usable=true` : base;
}

/**
 * Fetch + parse user allowed-models (testable without Electron session).
 * Default usable=true (consumer): catalog free always when over/unset; paid only when FY ceiling set and not over.
 */
export async function fetchUserAllowedAiModelsForToken(input: {
  token: string;
  alternateToken?: string | null;
  email: string;
  fetchFn?: FetchFn;
  usable?: boolean;
}): Promise<HubUserAllowedAiModels> {
  const fetchFn = input.fetchFn ?? fetch;
  const usable = input.usable !== false;
  const path = allowedModelsPath(input.email, usable);
  let result = await hubGet(path, input.token, fetchFn);

  if (
    (!result.ok || result.status === 401 || result.status === 403) &&
    input.alternateToken
  ) {
    logWarn('[HubAiGovernance]', path, 'failed with primary token — retrying alternate');
    result = await hubGet(path, input.alternateToken, fetchFn);
  }

  if (result.ok && isSuccessEnvelope(result.json)) {
    return parseUserAllowedAiModels(result.json);
  }

  throw new HubAiGovernanceError(
    result.status || 502,
    result.status === 401
      ? `Hub rejected Cognito token for ${path} (401). Try signing out and back in.`
      : `Failed to load Hub allowed AI models (${result.status || 'network'})`
  );
}

/**
 * Cached user allowed-models for the signed-in email.
 */
export async function fetchUserAllowedAiModels(options?: {
  fetchFn?: FetchFn;
  forceRefresh?: boolean;
  usable?: boolean;
}): Promise<HubUserAllowedAiModels> {
  const { token, alternateToken, email } = await resolveAccessToken();
  const emailKey = email.toLowerCase();
  const usable = options?.usable !== false;
  const cacheKey = allowedCacheKey(emailKey, usable);
  const cached = allowedCacheMap.get(cacheKey);

  if (!options?.forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await fetchUserAllowedAiModelsForToken({
    token,
    alternateToken,
    email,
    fetchFn: options?.fetchFn,
    usable,
  });
  allowedCacheMap.set(cacheKey, { email: emailKey, data, fetchedAt: Date.now() });
  log(
    '[HubAiGovernance] Loaded allowed-models for',
    email,
    `(${data.modelIds.length} models, has_budget=${data.hasBudget}, usable=${usable})`
  );
  return data;
}

/**
 * Fetch + parse user AI budget snapshot (testable without Electron session).
 */
export async function fetchUserAiBudgetForToken(input: {
  token: string;
  alternateToken?: string | null;
  email: string;
  fetchFn?: FetchFn;
}): Promise<HubUserAiBudgetSnapshot> {
  const fetchFn = input.fetchFn ?? fetch;
  const path = userAiBudgetPath(input.email);
  let result = await hubGet(path, input.token, fetchFn);

  if (
    (!result.ok || result.status === 401 || result.status === 403) &&
    input.alternateToken
  ) {
    logWarn('[HubAiGovernance]', path, 'failed with primary token — retrying alternate');
    result = await hubGet(path, input.alternateToken, fetchFn);
  }

  if (result.ok && isSuccessEnvelope(result.json)) {
    return parseHubUserAiBudget(result.json);
  }

  throw new HubAiGovernanceError(
    result.status || 502,
    result.status === 401
      ? `Hub rejected Cognito token for ${path} (401). Try signing out and back in.`
      : `Failed to load Hub user AI budget (${result.status || 'network'})`
  );
}

/**
 * Cached Hub GET /api/users/:email/ai-budget for the signed-in user (FE gating).
 */
export async function fetchUserAiBudget(options?: {
  fetchFn?: FetchFn;
  forceRefresh?: boolean;
}): Promise<HubUserAiBudgetSnapshot> {
  const { token, alternateToken, email } = await resolveAccessToken();
  const emailKey = email.toLowerCase();

  if (
    !options?.forceRefresh &&
    userBudgetCache &&
    userBudgetCache.email === emailKey &&
    Date.now() - userBudgetCache.fetchedAt < CACHE_TTL_MS
  ) {
    return userBudgetCache.data;
  }

  const data = await fetchUserAiBudgetForToken({
    token,
    alternateToken,
    email,
    fetchFn: options?.fetchFn,
  });
  userBudgetCache = { email: emailKey, data, fetchedAt: Date.now() };
  log(
    '[HubAiGovernance] Loaded user AI budget for',
    email,
    `(status=${data.status}, remaining=${data.remaining})`
  );
  return data;
}

/**
 * Cached picker list: org catalog intersected with user allowed-models when available.
 * Default usable=true (consumer). Pass usable=false for LaunchPad paid re-enable.
 * If allowed-models fails, returns the full catalog (does not empty the picker).
 */
export async function fetchHubGovernanceModels(options?: {
  fetchFn?: FetchFn;
  forceRefresh?: boolean;
  usable?: boolean;
}): Promise<BackendModelInfo[]> {
  const usable = options?.usable !== false;
  const key = modelsCacheKey(usable);
  const cached = modelsCache.get(key);
  if (!options?.forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }

  const { token, alternateToken, email } = await resolveAccessToken();
  const catalog = await fetchHubGovernanceModelsForToken({
    token,
    alternateToken,
    fetchFn: options?.fetchFn,
  });

  let allowed: HubUserAllowedAiModels | null = null;
  try {
    allowed = await fetchUserAllowedAiModelsForToken({
      token,
      alternateToken,
      email,
      fetchFn: options?.fetchFn,
      usable,
    });
    allowedCacheMap.set(allowedCacheKey(email, usable), {
      email: email.toLowerCase(),
      data: allowed,
      fetchedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof HubAiGovernanceError) {
      logWarn(
        '[HubAiGovernance] allowed-models failed — using full catalog:',
        error.status,
        error.message
      );
    } else {
      logWarn('[HubAiGovernance] allowed-models failed — using full catalog:', error);
    }
  }

  const models = joinCatalogWithAllowedModels(catalog, allowed);
  modelsCache.set(key, { models, fetchedAt: Date.now() });
  const pickerIds = new Set(models.map((m) => m.id));
  const omitted = catalog.filter((m) => !pickerIds.has(m.id));
  log(
    '[HubAiGovernance] Loaded',
    models.length,
    'picker models',
    `(catalog=${catalog.length}, allowed=${allowed ? allowed.modelIds.length : 'n/a'}, usable=${usable})`,
    `@ ${authConfig.hubApiUrl}${MODELS_PATH}`
  );
  log(
    '[HubAiGovernance] Picker:',
    models.map((m) => `${m.provider}/${m.id}`).join(', ') || '(none)'
  );
  if (omitted.length > 0) {
    log(
      '[HubAiGovernance] Catalog omitted from picker:',
      omitted.map((m) => `${m.provider}/${m.id}`).join(', ')
    );
  }
  if (allowed && allowed.grants.length > 0) {
    log(
      '[HubAiGovernance] Grants:',
      allowed.grants.map((g) => `${g.modelId}:${g.source || 'unknown'}`).join(', ')
    );
  }
  return models;
}

/**
 * POST usage event (testable without Electron session).
 * Throws HubAiGovernanceError on non-OK / failed envelope.
 */
export async function postHubGovernanceUsageForToken(input: {
  token: string;
  alternateToken?: string | null;
  payload: HubGovernanceUsagePayload;
  fetchFn?: FetchFn;
}): Promise<Record<string, unknown> & HubGovernanceUsageIngestResult> {
  const fetchFn = input.fetchFn ?? fetch;
  let result = await hubPost(USAGE_PATH, input.token, input.payload, fetchFn);

  if (
    (!result.ok || result.status === 401 || result.status === 403) &&
    input.alternateToken
  ) {
    logWarn('[HubAiGovernance]', USAGE_PATH, 'failed with primary token — retrying alternate');
    result = await hubPost(USAGE_PATH, input.alternateToken, input.payload, fetchFn);
  }

  if (result.ok && isSuccessEnvelope(result.json)) {
    const root = asRecord(result.json) || {};
    const data = asRecord(root.data) || asRecord(result.json) || {};
    const parsed = parseHubGovernanceUsageResponse(result.json);
    if (parsed.userBudgetPercent != null && parsed.userBudgetPercent >= 100) {
      clearHubGovernanceModelsCache();
    }
    return {
      ...data,
      userBudgetPercent: parsed.userBudgetPercent,
      projectBudgetPercent: parsed.projectBudgetPercent,
    };
  }

  throw new HubAiGovernanceError(
    result.status || 502,
    result.status === 401
      ? `Hub rejected Cognito token for ${USAGE_PATH} (401). Try signing out and back in.`
      : `Failed to post Hub AI governance usage (${result.status || 'network'})`
  );
}

/**
 * Post a usage event. Swallows errors (log only) — safe for fire-and-forget from agent stream.
 */
export async function postHubGovernanceUsage(
  payload: HubGovernanceUsagePayload,
  options?: { fetchFn?: FetchFn }
): Promise<void> {
  try {
    const { token, alternateToken } = await resolveAccessToken();
    await postHubGovernanceUsageForToken({
      token,
      alternateToken,
      payload,
      fetchFn: options?.fetchFn,
    });
  } catch (error) {
    if (error instanceof HubAiGovernanceError) {
      logWarn('[HubAiGovernance] usage POST failed:', error.status, error.message);
    } else {
      logWarn('[HubAiGovernance] usage POST failed:', error);
    }
  }
}

/**
 * Build + post usage from pi-ai message_end context. Fire-and-forget safe.
 * No-ops when payload cannot be built (no tokens/cost).
 */
export function reportHubGovernanceUsageFromCompletion(input: BuildHubUsageInput): void {
  const payload = buildHubUsagePayloadFromPiUsage(input);
  if (!payload) return;
  void postHubGovernanceUsage(payload);
}

/** Fire-and-forget Hub usage for MCP vision completions (main-process auth). */
export function reportMcpVisionUsage(input: {
  modelId: string;
  provider: string;
  usage: unknown;
  latencyMs?: number | null;
  functionName?: string | null;
  requestId?: string | null;
  status?: 'ok' | 'error';
}): void {
  const normalized = extractVisionApiUsage(input.usage) ?? input.usage;
  reportHubGovernanceUsageFromCompletion({
    modelId: input.modelId,
    provider: input.provider,
    sessionId: 'mcp_vision',
    feature: 'mcp_vision',
    usage: normalized,
    responseId: input.requestId,
    latencyMs: input.latencyMs,
    status: input.status ?? 'ok',
    metadata: input.functionName ? { vision_function: input.functionName } : null,
  });
}
