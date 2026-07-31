/**
 * Resolve a free / low-cost model for offloaded child agents (MCP run, spawn_subagent).
 * Preference: openrouter/free (when user BYOK present) → any OpenRouter *:free → Auto eco → parent.
 */
import { pickAutoModel, scorePromptComplexity } from '../../shared/auto-model';
import {
  applyBackendManagedCredentials,
  getBackendProxyBaseUrl,
  type BackendCloudProvider,
  type BackendModelInfo,
} from '../../shared/backend-config';
import { filterModelsForOpenRouterKey } from '../../shared/openrouter-fallback';
import { hasOpenRouterUserApiKey } from '../../shared/openrouter-user-key';
import {
  filterModelsForDivision,
  isProviderAllowedInDivision,
  type SessionDivisionFields,
} from '../../shared/workspace-division';
import { fetchBackendModels } from '../config/backend-client';
import { configStore } from '../config/config-store';
import { log, logWarn } from '../utils/logger';
import { resolveAutoModelIfNeeded } from './auto-model-resolve';

export const OPENROUTER_FREE_ROUTER_ID = 'openrouter/free';

export type FreeModelStrategy =
  | 'openrouter-free'
  | 'openrouter-free-variant'
  | 'eco-auto'
  | 'parent-fallback';

export interface FreeModelResolveResult {
  modelId: string;
  provider: BackendCloudProvider | string;
  customProtocol: 'anthropic' | 'openai' | 'gemini';
  baseUrl: string;
  apiKey: string;
  strategy: FreeModelStrategy;
}

export interface ParentModelFallback {
  model?: string;
  provider?: string;
  customProtocol?: 'anthropic' | 'openai' | 'gemini';
  baseUrl?: string;
  apiKey?: string;
  autoModelPreference?: string;
}

function protocolForProvider(provider: string): 'anthropic' | 'openai' | 'gemini' {
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
  const models = await fetchBackendModels();
  cachedModels = models;
  cachedModelsAt = now;
  return models;
}

/** Test helper: clear catalog cache. */
export function clearFreeModelCatalogCache(): void {
  cachedModels = null;
  cachedModelsAt = 0;
}

/**
 * Pick the best free OpenRouter catalog entry (pure; no I/O).
 */
export function pickFreeOpenRouterModel(
  enabledModels: BackendModelInfo[]
): { model: BackendModelInfo; strategy: 'openrouter-free' | 'openrouter-free-variant' } | null {
  const openrouter = enabledModels.filter((m) => m.provider === 'openrouter');
  const router = openrouter.find((m) => m.id === OPENROUTER_FREE_ROUTER_ID);
  if (router) {
    return { model: router, strategy: 'openrouter-free' };
  }
  const freeVariant = openrouter.find(
    (m) => m.id.endsWith(':free') || m.id.includes(':free/') || /:free$/i.test(m.id)
  );
  if (freeVariant) {
    return { model: freeVariant, strategy: 'openrouter-free-variant' };
  }
  return null;
}

function withOpenRouterCreds(modelId: string, strategy: FreeModelStrategy): FreeModelResolveResult {
  const creds = applyBackendManagedCredentials({
    provider: 'openrouter',
    apiKey: '',
    baseUrl: '',
  });
  return {
    modelId,
    provider: 'openrouter',
    customProtocol: 'openai',
    baseUrl: creds.baseUrl || getBackendProxyBaseUrl('openrouter'),
    apiKey: creds.apiKey || '',
    strategy,
  };
}

/**
 * Resolve a free/cheap model for a child agent.
 */
export async function resolveFreeModelForChild(options: {
  promptText?: string;
  enabledModels?: BackendModelInfo[];
  parent?: ParentModelFallback;
  /** When omitted, reads from config store. */
  openRouterUserApiKey?: string | null;
  /** Session workspace division — General is OpenRouter-only. */
  division?: Partial<SessionDivisionFields> | null;
}): Promise<FreeModelResolveResult> {
  const openRouterUserApiKey =
    options.openRouterUserApiKey !== undefined
      ? options.openRouterUserApiKey
      : configStore.getAll().openRouterUserApiKey;
  const rawModels = await getEnabledModels(options.enabledModels);
  const enabledModels = filterModelsForOpenRouterKey(
    filterModelsForDivision(rawModels, options.division),
    openRouterUserApiKey
  );
  const canUseOpenRouter = hasOpenRouterUserApiKey(openRouterUserApiKey);
  const freePick = canUseOpenRouter ? pickFreeOpenRouterModel(enabledModels) : null;

  if (freePick) {
    log(`[FreeModel] Using ${freePick.model.provider}/${freePick.model.id} (${freePick.strategy})`);
    return withOpenRouterCreds(freePick.model.id, freePick.strategy);
  }

  // No free OpenRouter models available (or no BYOK) — try Auto with eco preference.
  const ecoRoute = await resolveAutoModelIfNeeded({
    model: 'auto',
    preference: 'eco',
    promptText: options.promptText || 'focused sub-task',
    messageCount: 1,
    contextChars: (options.promptText || '').length,
    enabledModels,
    division: options.division,
    openRouterUserApiKey,
  });

  if (ecoRoute.usedAuto && ecoRoute.modelId) {
    logWarn(
      `[FreeModel] No OpenRouter free models available; falling back to eco Auto ` +
        `${ecoRoute.provider}/${ecoRoute.modelId}`
    );
    return {
      modelId: ecoRoute.modelId,
      provider: ecoRoute.provider,
      customProtocol: ecoRoute.customProtocol,
      baseUrl: ecoRoute.baseUrl,
      apiKey: ecoRoute.apiKey,
      strategy: 'eco-auto',
    };
  }

  // Last resort: parent config (may still be auto — resolve it).
  const parent = options.parent || {};
  const parentModel = parent.model?.trim() || 'auto';
  if (parentModel.toLowerCase() === 'auto') {
    const parentAuto = await resolveAutoModelIfNeeded({
      model: 'auto',
      preference: parent.autoModelPreference || 'eco',
      promptText: options.promptText || 'focused sub-task',
      messageCount: 1,
      contextChars: (options.promptText || '').length,
      enabledModels,
      division: options.division,
      openRouterUserApiKey,
    });
    if (parentAuto.usedAuto && parentAuto.modelId) {
      logWarn(
        `[FreeModel] Falling back to parent Auto route ${parentAuto.provider}/${parentAuto.modelId}`
      );
      return {
        modelId: parentAuto.modelId,
        provider: parentAuto.provider,
        customProtocol: parentAuto.customProtocol,
        baseUrl: parentAuto.baseUrl,
        apiKey: parentAuto.apiKey,
        strategy: 'parent-fallback',
      };
    }
  }

  // Catalog empty / no auto — use curated eco pick or parent fields as-is.
  const score = scorePromptComplexity(options.promptText || '', { messageCount: 1 });
  const curated = pickAutoModel(enabledModels, score, 'eco');
  if (enabledModels.length > 0 && curated.modelId) {
    const creds = applyBackendManagedCredentials({
      provider: curated.provider,
      apiKey: '',
      baseUrl: '',
    });
    logWarn(`[FreeModel] Falling back to curated eco pick ${curated.provider}/${curated.modelId}`);
    return {
      modelId: curated.modelId,
      provider: curated.provider,
      customProtocol: protocolForProvider(curated.provider),
      baseUrl: creds.baseUrl || getBackendProxyBaseUrl(curated.provider),
      apiKey: creds.apiKey || '',
      strategy: 'parent-fallback',
    };
  }

  const provider = parent.provider || 'anthropic';
  if (!isProviderAllowedInDivision(provider, options.division)) {
    logWarn(
      `[FreeModel] Parent provider ${provider} blocked in General; using OpenRouter free router`
    );
    return withOpenRouterCreds(OPENROUTER_FREE_ROUTER_ID, 'parent-fallback');
  }
  logWarn(`[FreeModel] No catalog models; using parent config ${provider}/${parentModel}`);
  return {
    modelId: parentModel,
    provider,
    customProtocol: parent.customProtocol || protocolForProvider(provider),
    baseUrl: parent.baseUrl?.trim() || '',
    apiKey: parent.apiKey || '',
    strategy: 'parent-fallback',
  };
}
