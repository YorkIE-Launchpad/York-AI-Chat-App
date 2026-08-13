/**
 * Pure Hub AI Governance usage payload helpers (no Electron / auth).
 * Safe to import from MCP subprocesses.
 */

export const HUB_USAGE_SOURCE = 'vecos';
export const HUB_USAGE_FEATURE_DEFAULT = 'chat';
export const HUB_USAGE_PATH = '/api/ai-governance/usage';

/** Request body for POST /api/ai-governance/usage (apidoc sample). */
export interface HubGovernanceUsagePayload {
  model_id: string;
  provider: string;
  source: string;
  feature: string;
  session_id?: string;
  project_id?: string;
  request_id?: string;
  occurred_at: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  cost?: number;
  currency?: string;
  input_cost?: number;
  output_cost?: number;
  latency_ms?: number;
  status: 'ok' | 'error';
  error_code?: string;
  metadata?: Record<string, unknown>;
}

export interface BuildHubUsageInput {
  modelId: string;
  provider: string;
  sessionId: string;
  hubProjectId?: string | null;
  folderId?: string | null;
  launchpadProjectId?: number | null;
  division?: string | null;
  /** Hub `feature` tag (default: chat). */
  feature?: string | null;
  /** Extra metadata merged into the payload (e.g. subagent_id). */
  metadata?: Record<string, unknown> | null;
  /** Raw pi-ai / SDK usage object (may include cost, cache, totalTokens). */
  usage: unknown;
  /** Optional pi-ai AssistantMessage.responseId */
  responseId?: string | null;
  latencyMs?: number | null;
  status?: 'ok' | 'error';
  errorCode?: string | null;
  occurredAt?: Date;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberField(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Build a Hub usage ingest payload from pi-ai / SDK usage + session context.
 * Returns null when neither token fields nor cost are present (API requirement).
 */
export function buildHubUsagePayloadFromPiUsage(
  input: BuildHubUsageInput
): HubGovernanceUsagePayload | null {
  const modelId = (input.modelId || '').trim();
  const provider = (input.provider || '').trim();
  if (!modelId || !provider) return null;

  const usage = asRecord(input.usage) || {};
  const promptTokens = numberField(
    usage,
    'input',
    'input_tokens',
    'inputTokens',
    'prompt_tokens'
  );
  const completionTokens = numberField(
    usage,
    'output',
    'output_tokens',
    'outputTokens',
    'completion_tokens'
  );
  const totalFromUsage = numberField(usage, 'totalTokens', 'total_tokens', 'total');
  const cacheRead = numberField(usage, 'cacheRead', 'cache_read', 'cached_tokens');
  const cacheWrite = numberField(usage, 'cacheWrite', 'cache_write');
  const cachedTokens =
    cacheRead !== undefined || cacheWrite !== undefined
      ? (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined;

  const costObj = asRecord(usage.cost);
  const inputCost = costObj ? numberField(costObj, 'input') : undefined;
  const outputCost = costObj ? numberField(costObj, 'output') : undefined;
  const cacheReadCost = costObj ? numberField(costObj, 'cacheRead', 'cache_read') : undefined;
  const cacheWriteCost = costObj ? numberField(costObj, 'cacheWrite', 'cache_write') : undefined;
  const totalCost =
    (costObj ? numberField(costObj, 'total') : undefined) ??
    numberField(usage, 'cost') ??
    (inputCost !== undefined ||
    outputCost !== undefined ||
    cacheReadCost !== undefined ||
    cacheWriteCost !== undefined
      ? (inputCost ?? 0) + (outputCost ?? 0) + (cacheReadCost ?? 0) + (cacheWriteCost ?? 0)
      : undefined);

  const totalTokens =
    totalFromUsage ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);

  const hasTokens =
    promptTokens !== undefined ||
    completionTokens !== undefined ||
    totalTokens !== undefined ||
    cachedTokens !== undefined;
  const hasCost = totalCost !== undefined || inputCost !== undefined || outputCost !== undefined;
  if (!hasTokens && !hasCost) return null;

  const metadata: Record<string, unknown> = {};
  if (input.division) metadata.workspace = input.division;
  if (input.folderId) metadata.folder_id = input.folderId;
  if (input.launchpadProjectId != null) {
    metadata.launchpad_project_id = input.launchpadProjectId;
  }
  if (input.metadata && typeof input.metadata === 'object') {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (value !== undefined) metadata[key] = value;
    }
  }

  const feature = (input.feature || '').trim() || HUB_USAGE_FEATURE_DEFAULT;

  const payload: HubGovernanceUsagePayload = {
    model_id: modelId,
    provider,
    source: HUB_USAGE_SOURCE,
    feature,
    session_id: input.sessionId,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    status: input.status ?? 'ok',
  };

  if (input.hubProjectId) payload.project_id = input.hubProjectId;
  const requestId = (input.responseId || '').trim();
  if (requestId) payload.request_id = requestId;
  if (promptTokens !== undefined) payload.prompt_tokens = promptTokens;
  if (completionTokens !== undefined) payload.completion_tokens = completionTokens;
  if (totalTokens !== undefined) payload.total_tokens = totalTokens;
  if (cachedTokens !== undefined) payload.cached_tokens = cachedTokens;
  if (totalCost !== undefined) {
    payload.cost = totalCost;
    payload.currency = 'USD';
  }
  if (inputCost !== undefined) payload.input_cost = inputCost;
  if (outputCost !== undefined) payload.output_cost = outputCost;
  if (
    typeof input.latencyMs === 'number' &&
    Number.isFinite(input.latencyMs) &&
    input.latencyMs >= 0
  ) {
    payload.latency_ms = Math.round(input.latencyMs);
  }
  if (input.errorCode) payload.error_code = input.errorCode;
  if (Object.keys(metadata).length > 0) payload.metadata = metadata;

  return payload;
}

/**
 * Normalize OpenAI chat-completions or Anthropic messages `usage` into a pi-like shape
 * accepted by buildHubUsagePayloadFromPiUsage.
 */
export function extractVisionApiUsage(raw: unknown): Record<string, number> | null {
  const usage = asRecord(raw);
  if (!usage) return null;

  const promptTokens = numberField(
    usage,
    'prompt_tokens',
    'input_tokens',
    'inputTokens',
    'input'
  );
  const completionTokens = numberField(
    usage,
    'completion_tokens',
    'output_tokens',
    'outputTokens',
    'output'
  );
  const totalTokens = numberField(usage, 'total_tokens', 'totalTokens', 'total');

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  const out: Record<string, number> = {};
  if (promptTokens !== undefined) out.input = promptTokens;
  if (completionTokens !== undefined) out.output = completionTokens;
  if (totalTokens !== undefined) {
    out.totalTokens = totalTokens;
  } else if (promptTokens !== undefined || completionTokens !== undefined) {
    out.totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }
  return out;
}

/**
 * Fire-and-forget Hub usage POST using an explicit bearer token (MCP-safe).
 * No-ops when token/url missing or payload cannot be built.
 */
export function reportHubUsageWithBearerToken(input: {
  hubApiUrl: string;
  accessToken: string;
  build: BuildHubUsageInput;
  fetchFn?: typeof fetch;
}): void {
  const token = (input.accessToken || '').trim();
  const base = (input.hubApiUrl || '').replace(/\/$/, '');
  if (!token || !base) return;

  const payload = buildHubUsagePayloadFromPiUsage(input.build);
  if (!payload) return;

  const fetchFn = input.fetchFn ?? fetch;
  void fetchFn(`${base}${HUB_USAGE_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {
    /* swallow — never block callers */
  });
}

/** MCP vision helper: normalize usage + post with env/injected bearer token. */
export function reportMcpVisionUsageViaEnv(input: {
  modelId: string;
  provider: string;
  usage: unknown;
  latencyMs?: number | null;
  functionName?: string | null;
  requestId?: string | null;
  status?: 'ok' | 'error';
  hubApiUrl?: string | null;
  accessToken?: string | null;
  fetchFn?: typeof fetch;
}): void {
  const accessToken =
    (input.accessToken || '').trim() ||
    (typeof process !== 'undefined' ? process.env.YORK_HUB_ACCESS_TOKEN?.trim() : '') ||
    '';
  const hubApiUrl =
    (input.hubApiUrl || '').trim() ||
    (typeof process !== 'undefined'
      ? process.env.YORK_HUB_API_URL?.trim() || process.env.HUB_API_URL?.trim()
      : '') ||
    '';
  if (!accessToken || !hubApiUrl) return;

  const normalized = extractVisionApiUsage(input.usage) ?? input.usage;
  reportHubUsageWithBearerToken({
    hubApiUrl,
    accessToken,
    fetchFn: input.fetchFn,
    build: {
      modelId: input.modelId,
      provider: input.provider,
      sessionId: 'mcp_vision',
      feature: 'mcp_vision',
      usage: normalized,
      responseId: input.requestId,
      latencyMs: input.latencyMs,
      status: input.status ?? 'ok',
      metadata: input.functionName ? { vision_function: input.functionName } : null,
    },
  });
}
