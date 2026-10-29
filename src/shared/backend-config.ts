import { API_PROVIDER_PRESETS, type SharedProviderType } from './api-model-presets';

/** Placeholder stored in config; never sent upstream. Request-time Cognito JWT replaces it. */
export const BACKEND_PROXY_PLACEHOLDER_KEY = 'sk-york-ie-local-proxy';

export function isBackendProxyPlaceholderKey(apiKey: string | undefined | null): boolean {
  const value = apiKey?.trim();
  if (!value) return false;
  return value === BACKEND_PROXY_PLACEHOLDER_KEY || value === 'york-ie-local-proxy';
}

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3001';

export function resolveBackendUrl(): string {
  const fromEnv =
    typeof process !== 'undefined' && process.env?.YORK_IE_BACKEND_URL
      ? process.env.YORK_IE_BACKEND_URL.trim()
      : '';
  return fromEnv || DEFAULT_BACKEND_URL;
}

/** WebSocket origin for the backend (`https` → `wss`, `http` → `ws`). */
export function resolveBackendWsUrl(backendUrl: string = resolveBackendUrl()): string {
  const http = backendUrl.replace(/\/+$/, '');
  if (http.startsWith('https://')) return `wss://${http.slice('https://'.length)}`;
  if (http.startsWith('http://')) return `ws://${http.slice('http://'.length)}`;
  return `ws://${http}`;
}

/** True when the URL's host is a loopback address (plain `ws://` is only acceptable there). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

export type BackendCloudProvider = 'anthropic' | 'openai' | 'gemini';

export function isBackendManagedProvider(
  provider: SharedProviderType | string | undefined
): provider is BackendCloudProvider {
  return provider === 'anthropic' || provider === 'openai' || provider === 'gemini';
}

const BACKEND_PROVIDER_LOOKUP_ORDER: BackendCloudProvider[] = ['anthropic', 'openai', 'gemini'];

/**
 * Infer York-proxy provider for a Hub grant that is not in GET /models
 * (e.g. group-only allowlist rows).
 */
export function inferBackendCloudProviderForModelId(modelId: string): BackendCloudProvider | null {
  const id = modelId.trim();
  if (!id) return null;
  const lower = id.toLowerCase();
  for (const provider of BACKEND_PROVIDER_LOOKUP_ORDER) {
    if (API_PROVIDER_PRESETS[provider].models.some((m) => m.id.toLowerCase() === lower)) {
      return provider;
    }
  }
  if (lower.startsWith('claude-')) return 'anthropic';
  if (lower.startsWith('gemini-')) return 'gemini';
  if (/^(gpt-|o[1-4]|chatgpt-)/.test(lower)) return 'openai';
  return null;
}

/** Base URL pi-ai / SDK should call (local proxy). */
export function getBackendProxyBaseUrl(
  provider: BackendCloudProvider,
  backendUrl: string = resolveBackendUrl()
): string {
  const base = backendUrl.replace(/\/+$/, '');
  switch (provider) {
    case 'anthropic':
      return `${base}/anthropic`;
    case 'openai':
      return `${base}/openai/v1`;
    case 'gemini':
      // pi-ai/@google/genai clears apiVersion when baseUrl is set, so the version
      // must live on the base URL (same pattern as openai → /openai/v1).
      return `${base}/gemini/v1beta`;
    default:
      return base;
  }
}

/**
 * TypeSafe Jev (System One) proxy root.
 * SDK calls `{baseURL}/v1/systemone`, so do not append `/v1` here.
 */
export function getTypesafeProxyBaseUrl(backendUrl: string = resolveBackendUrl()): string {
  return `${backendUrl.replace(/\/+$/, '')}/typesafe`;
}

export interface BackendModelInfo {
  id: string;
  name: string;
  provider: BackendCloudProvider;
  /** Hub catalog: model stays on org key after user FY is over or unset. */
  isFree?: boolean;
  /** Hub catalog default-active flag. */
  isDefaultActive?: boolean;
  /**
   * From user allowed-models grant: is_free || root has_budget.
   * Root has_budget is true only when a FY ceiling is set and not over (ok/warning).
   * false → paid model while over/unset; not usable until budget is restored.
   */
  hasBudget?: boolean;
  /** USD per 1M input tokens from Hub catalog; null when unset. */
  inputPrice?: number | null;
  /** USD per 1M output tokens from Hub catalog; null when unset. */
  outputPrice?: number | null;
  /** USD per 1M cache-read tokens from Hub catalog; null when unset. */
  cacheReadPrice?: number | null;
  /** USD per 1M cache-write tokens from Hub catalog; null when unset. */
  cacheWritePrice?: number | null;
}

const PROFILE_KEY_TO_BACKEND_PROVIDER: Record<string, BackendCloudProvider> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
};

export function backendProviderForProfileKey(profileKey: string): BackendCloudProvider | null {
  return PROFILE_KEY_TO_BACKEND_PROVIDER[profileKey] ?? null;
}

/** Force proxy base URL + placeholder key for cloud providers managed by the local backend. */
export function applyBackendManagedCredentials<
  T extends { provider?: string; apiKey?: string; baseUrl?: string },
>(config: T): T {
  if (!isBackendManagedProvider(config.provider)) {
    return config;
  }
  const provider = config.provider as BackendCloudProvider;
  return {
    ...config,
    apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
    baseUrl: getBackendProxyBaseUrl(provider),
  };
}
