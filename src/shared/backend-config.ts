import type { SharedProviderType } from './api-model-presets';

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

export type BackendCloudProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter';

export function isBackendManagedProvider(
  provider: SharedProviderType | string | undefined
): provider is BackendCloudProvider {
  return (
    provider === 'anthropic' ||
    provider === 'openai' ||
    provider === 'gemini' ||
    provider === 'openrouter'
  );
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
      return `${base}/gemini`;
    case 'openrouter':
      return `${base}/openrouter/v1`;
    default:
      return base;
  }
}

export interface BackendModelInfo {
  id: string;
  name: string;
  provider: BackendCloudProvider;
}

const PROFILE_KEY_TO_BACKEND_PROVIDER: Record<string, BackendCloudProvider> = {
  openrouter: 'openrouter',
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
