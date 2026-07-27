/**
 * Resolve the virtual `auto` model to a concrete catalog entry before pi-ai lookup.
 */
import {
  AUTO_MODEL_ID,
  isAutoModelId,
  normalizeAutoModelPreference,
  pickAutoModel,
  scorePromptComplexity,
  type AutoModelPick,
  type AutoModelPreference,
} from '../../shared/auto-model';
import {
  applyBackendManagedCredentials,
  getBackendProxyBaseUrl,
  type BackendCloudProvider,
  type BackendModelInfo,
} from '../../shared/backend-config';
import { filterModelsForOpenRouterKey } from '../../shared/openrouter-fallback';
import { fetchBackendModels } from '../config/backend-client';
import { configStore } from '../config/config-store';
import { log } from '../utils/logger';

export interface AutoResolveInput {
  model: string | undefined;
  preference?: AutoModelPreference | string;
  promptText: string;
  hasImages?: boolean;
  messageCount?: number;
  contextChars?: number;
  /** Optional prefetched catalog; fetched from backend when omitted. */
  enabledModels?: BackendModelInfo[];
  /** When omitted, reads from config store. */
  openRouterUserApiKey?: string | null;
}

export interface AutoResolveResult {
  usedAuto: boolean;
  modelId: string;
  provider: BackendCloudProvider;
  customProtocol: 'anthropic' | 'openai' | 'gemini';
  baseUrl: string;
  apiKey: string;
  pick: AutoModelPick | null;
}

function protocolForProvider(provider: BackendCloudProvider): 'anthropic' | 'openai' | 'gemini' {
  if (provider === 'gemini') return 'gemini';
  if (provider === 'openai' || provider === 'openrouter') return 'openai';
  return 'anthropic';
}

let cachedModels: BackendModelInfo[] | null = null;
let cachedModelsAt = 0;
const MODEL_CACHE_TTL_MS = 60_000;

async function getEnabledModels(prefetch?: BackendModelInfo[]): Promise<BackendModelInfo[]> {
  if (prefetch && prefetch.length > 0) return prefetch;
  const now = Date.now();
  if (cachedModels && now - cachedModelsAt < MODEL_CACHE_TTL_MS) {
    return cachedModels;
  }
  // Only providers with API keys (backend listEnabledModels). No static fallback.
  const models = await fetchBackendModels();
  cachedModels = models;
  cachedModelsAt = now;
  return models;
}

/**
 * If `model` is `auto`, pick a concrete provider/model and return proxy credentials.
 * Otherwise return `usedAuto: false` with empty routing fields (caller keeps its config).
 */
export async function resolveAutoModelIfNeeded(
  input: AutoResolveInput
): Promise<AutoResolveResult> {
  if (!isAutoModelId(input.model)) {
    return {
      usedAuto: false,
      modelId: input.model?.trim() || '',
      provider: 'anthropic',
      customProtocol: 'anthropic',
      baseUrl: '',
      apiKey: '',
      pick: null,
    };
  }

  const preference = normalizeAutoModelPreference(input.preference);
  const score = scorePromptComplexity(input.promptText, {
    hasImages: input.hasImages,
    messageCount: input.messageCount,
    contextChars: input.contextChars,
  });
  const rawModels = await getEnabledModels(input.enabledModels);
  const openRouterUserApiKey =
    input.openRouterUserApiKey !== undefined
      ? input.openRouterUserApiKey
      : configStore.getAll().openRouterUserApiKey;
  const enabledModels = filterModelsForOpenRouterKey(rawModels, openRouterUserApiKey);
  const pick = pickAutoModel(enabledModels, score, preference, {
    requireVision: Boolean(input.hasImages),
  });

  const creds = applyBackendManagedCredentials({
    provider: pick.provider,
    apiKey: '',
    baseUrl: '',
  });

  log(
    `[AutoModel] Routed to ${pick.provider}/${pick.modelId} (tier=${pick.tier}, score=${pick.score}, ${pick.reason})`
  );

  return {
    usedAuto: true,
    modelId: pick.modelId,
    provider: pick.provider,
    customProtocol: protocolForProvider(pick.provider),
    baseUrl: creds.baseUrl || getBackendProxyBaseUrl(pick.provider),
    apiKey: creds.apiKey || '',
    pick,
  };
}

export function formatAutoRouteLabel(pick: AutoModelPick): string {
  return `${pick.provider}/${pick.modelId}`;
}

export { AUTO_MODEL_ID, isAutoModelId };
