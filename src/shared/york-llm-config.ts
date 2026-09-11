export const DEFAULT_YORK_LLM_BASE_URL = 'http://llm.yorkdevs.link:2222/v1';
export const DEFAULT_YORK_LLM_MAX_CONCURRENT = 4;
export const YORK_LLM_DISPLAY_NAME = 'York LLM V1';
export const YORK_LLM_SESSION_HEADER = 'X-York-Llm-Session-Id';
/** Provider key used when York LLM is selected in the model picker. */
export const YORK_LLM_PROVIDER = 'ollama' as const;
/** Legacy system defaults that should migrate to York LLM (not intentional user picks). */
export const LEGACY_DEFAULT_MODEL_IDS = new Set(['auto', 'openrouter/free']);

/** Activity timeout for York turns (slow shared llama.cpp). Cloud stays at 5 min. */
export const YORK_LLM_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
/** SDK auto-retries for idle/network blips on the shared York server. */
export const YORK_LLM_SDK_MAX_RETRIES = 3;

const YORK_LLM_HOST_PATTERN = /(?:^|\.)llm\.yorkdevs\.link$/i;

function readEnv(name: string): string {
  if (typeof process !== 'undefined' && process.env?.[name]) {
    return process.env[name]!.trim();
  }
  return '';
}

export function resolveYorkLlmBaseUrl(): string {
  const fromEnv = readEnv('YORK_LLM_BASE_URL');
  return fromEnv || DEFAULT_YORK_LLM_BASE_URL;
}

/** llama.cpp `--api-key` — set via `YORK_LLM_API_KEY` only (no hardcoded default). */
export function resolveYorkLlmApiKey(): string {
  return readEnv('YORK_LLM_API_KEY');
}

/** True when stored model is empty or a retired system default (auto / openrouter/free). */
export function shouldMigrateToYorkLlmDefault(
  model: string | undefined | null,
  provider?: string | null
): boolean {
  const trimmed = model?.trim() ?? '';
  if (!trimmed) return true;
  if (LEGACY_DEFAULT_MODEL_IDS.has(trimmed.toLowerCase())) return true;
  // Legacy Auto sometimes stored under openrouter with model "auto".
  if (provider === 'openrouter' && trimmed.toLowerCase() === 'auto') return true;
  return false;
}

/** Config fields applied when selecting York LLM (model id filled by listing/bootstrap). */
export function yorkLlmSelectionPayload(modelId: string): {
  provider: typeof YORK_LLM_PROVIDER;
  activeProfileKey: typeof YORK_LLM_PROVIDER;
  customProtocol: 'openai';
  baseUrl: string;
  model: string;
  apiKey: string;
} {
  return {
    provider: YORK_LLM_PROVIDER,
    activeProfileKey: YORK_LLM_PROVIDER,
    customProtocol: 'openai',
    baseUrl: resolveYorkLlmBaseUrl(),
    model: modelId,
    apiKey: resolveYorkLlmApiKey(),
  };
}

export function resolveYorkLlmMaxConcurrent(): number {
  const raw = readEnv('YORK_LLM_MAX_CONCURRENT');
  if (!raw) {
    return DEFAULT_YORK_LLM_MAX_CONCURRENT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_YORK_LLM_MAX_CONCURRENT;
  }
  return Math.min(32, parsed);
}

export function isYorkLlmHost(hostname: string): boolean {
  const trimmed = hostname.trim().toLowerCase();
  if (!trimmed) return false;
  return YORK_LLM_HOST_PATTERN.test(trimmed);
}

export function isYorkLlmBaseUrl(baseUrl: string | undefined | null): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;
  try {
    return isYorkLlmHost(new URL(trimmed).hostname);
  } catch {
    return trimmed.includes('llm.yorkdevs.link');
  }
}

/** York LLM is org-hosted and free — never ingest cost into Hub AI Governance. */
export function shouldSkipHubUsageForYorkLlm(baseUrl: string | undefined | null): boolean {
  return isYorkLlmBaseUrl(baseUrl);
}

export const YORK_LLM_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export function isYorkLlmChatCompletionUrl(
  url: string | URL,
  baseUrl: string = resolveYorkLlmBaseUrl()
): boolean {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (!isYorkLlmHost(parsed.hostname)) {
      return false;
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    if (!normalizedPath.endsWith('/chat/completions')) {
      return false;
    }
    if (baseUrl) {
      const expected = new URL(baseUrl.replace(/\/+$/, ''));
      if (parsed.hostname !== expected.hostname) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function formatYorkLlmModelName(_id: string): string {
  return YORK_LLM_DISPLAY_NAME;
}

export function extractYorkLlmContextWindow(modelPayload: unknown): number | undefined {
  if (!modelPayload || typeof modelPayload !== 'object') {
    return undefined;
  }
  const row = modelPayload as Record<string, unknown>;
  const meta = row.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const nCtx = (meta as Record<string, unknown>).n_ctx;
    if (typeof nCtx === 'number' && Number.isFinite(nCtx) && nCtx > 0) {
      return Math.round(nCtx);
    }
  }
  return undefined;
}

export interface YorkLlmQueueEventPayload {
  sessionId?: string;
  ticketId: string;
  status: 'waiting' | 'active' | 'done';
  position: number;
  activeCount: number;
  maxConcurrent: number;
  waitingCount: number;
}

export interface YorkLlmGateSnapshot {
  maxConcurrent: number;
  activeCount: number;
  waitingCount: number;
  tickets: Array<{
    ticketId: string;
    sessionId?: string;
    position: number;
    status: 'waiting' | 'active';
  }>;
}
