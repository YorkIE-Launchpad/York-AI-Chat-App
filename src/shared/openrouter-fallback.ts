/**
 * Filter backend catalog models by whether OpenRouter BYOK is available,
 * and resolve York-paid eco fallback when OpenRouter hits account limits.
 */
import { pickAutoModel, scorePromptComplexity, type AutoModelPreference } from './auto-model';
import {
  applyBackendManagedCredentials,
  getBackendProxyBaseUrl,
  type BackendCloudProvider,
  type BackendModelInfo,
} from './backend-config';
import { hasOpenRouterUserApiKey } from './openrouter-user-key';

const YORK_CLOUD_PROVIDERS = new Set<BackendCloudProvider>(['anthropic', 'openai', 'gemini']);

export function filterModelsForOpenRouterKey(
  models: BackendModelInfo[],
  openRouterUserApiKey: string | undefined | null
): BackendModelInfo[] {
  if (hasOpenRouterUserApiKey(openRouterUserApiKey)) return models;
  return models.filter((m) => m.provider !== 'openrouter');
}

export function isYorkCloudProvider(provider: string | undefined): boolean {
  return Boolean(provider && YORK_CLOUD_PROVIDERS.has(provider as BackendCloudProvider));
}

export interface YorkPaidEcoFallbackResult {
  modelId: string;
  provider: BackendCloudProvider;
  customProtocol: 'anthropic' | 'openai' | 'gemini';
  baseUrl: string;
  apiKey: string;
}

function protocolForProvider(provider: BackendCloudProvider): 'anthropic' | 'openai' | 'gemini' {
  if (provider === 'gemini') return 'gemini';
  if (provider === 'openai') return 'openai';
  return 'anthropic';
}

/**
 * Pick lowest-cost York-managed model (Anthropic/OpenAI/Gemini only — never OpenRouter).
 */
export function resolveYorkPaidEcoFallback(options: {
  enabledModels: BackendModelInfo[];
  promptText?: string;
  preference?: AutoModelPreference | string;
}): YorkPaidEcoFallbackResult | null {
  const yorkModels = options.enabledModels.filter((m) => YORK_CLOUD_PROVIDERS.has(m.provider));
  if (yorkModels.length === 0) return null;

  const score = scorePromptComplexity(options.promptText || 'focused task', { messageCount: 1 });
  const pick = pickAutoModel(
    yorkModels,
    score,
    (options.preference as AutoModelPreference) || 'eco'
  );
  if (!pick.modelId || !YORK_CLOUD_PROVIDERS.has(pick.provider)) return null;

  const creds = applyBackendManagedCredentials({
    provider: pick.provider,
    apiKey: '',
    baseUrl: '',
  });

  return {
    modelId: pick.modelId,
    provider: pick.provider,
    customProtocol: protocolForProvider(pick.provider),
    baseUrl: creds.baseUrl || getBackendProxyBaseUrl(pick.provider),
    apiKey: creds.apiKey || '',
  };
}
