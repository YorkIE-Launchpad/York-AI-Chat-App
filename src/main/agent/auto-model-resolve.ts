/**
 * Resolve the virtual `auto` model to a concrete catalog entry before pi-ai lookup.
 * Routine (fast) prompts prefer York LLM when the shared server is reachable.
 */
import {
  AUTO_MODEL_ID,
  isAutoModelId,
  normalizeAutoModelPreference,
  pickAutoModel,
  scorePromptComplexity,
  tierForScore,
  type AutoModelPick,
  type AutoModelPreference,
  type AutoModelProvider,
} from '../../shared/auto-model';
import {
  applyBackendManagedCredentials,
  getBackendProxyBaseUrl,
  type BackendCloudProvider,
  type BackendModelInfo,
} from '../../shared/backend-config';
import { filterModelsForOpenRouterKey } from '../../shared/openrouter-fallback';
import {
  filterModelsForDivision,
  type SessionDivisionFields,
} from '../../shared/workspace-division';
import {
  YORK_LLM_PROVIDER,
  yorkLlmSelectionPayload,
} from '../../shared/york-llm-config';
import { fetchBackendModels } from '../config/backend-client';
import { listYorkLlmModels } from '../config/york-llm-api';
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
  /** Session workspace division (provider gating is FE-owned). */
  division?: Partial<SessionDivisionFields> | null;
  /** Optional prefetched York model id; listed when omitted and fast tier applies. */
  yorkLlmModelId?: string | null;
}

export interface AutoResolveResult {
  usedAuto: boolean;
  modelId: string;
  provider: AutoModelProvider;
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
  if (cachedModels && cachedModelsAt + MODEL_CACHE_TTL_MS > now) {
    return cachedModels;
  }
  // Only providers with API keys (backend listEnabledModels). No static fallback.
  const models = await fetchBackendModels();
  cachedModels = models;
  cachedModelsAt = now;
  return models;
}

async function resolveYorkLlmForFastTier(
  score: number,
  preference: AutoModelPreference,
  yorkLlmModelId?: string | null
): Promise<AutoResolveResult | null> {
  let modelId = yorkLlmModelId?.trim() || '';
  if (!modelId) {
    try {
      const models = await listYorkLlmModels();
      modelId = models[0]?.id?.trim() || '';
    } catch {
      return null;
    }
  }
  if (!modelId) return null;

  const payload = yorkLlmSelectionPayload(modelId);
  const pick: AutoModelPick = {
    provider: YORK_LLM_PROVIDER,
    modelId,
    tier: 'fast',
    score,
    reason: `tier=fast;preference=${preference};york-llm`,
  };

  log(`[AutoModel] Routed to York LLM ${modelId} (tier=fast, score=${score}, ${pick.reason})`);

  return {
    usedAuto: true,
    modelId,
    provider: YORK_LLM_PROVIDER,
    customProtocol: 'openai',
    baseUrl: payload.baseUrl,
    apiKey: payload.apiKey,
    pick,
  };
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
  const preferredTier = tierForScore(score, preference);

  // York LLM for routine (fast) asks — skip when images need vision-capable cloud models.
  if (preferredTier === 'fast' && !input.hasImages) {
    const yorkRoute = await resolveYorkLlmForFastTier(score, preference, input.yorkLlmModelId);
    if (yorkRoute) return yorkRoute;
  }

  const rawModels = await getEnabledModels(input.enabledModels);
  const openRouterUserApiKey =
    input.openRouterUserApiKey !== undefined
      ? input.openRouterUserApiKey
      : configStore.getAll().openRouterUserApiKey;
  const enabledModels = filterModelsForOpenRouterKey(
    filterModelsForDivision(rawModels, input.division),
    openRouterUserApiKey
  );
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
  if (pick.provider === YORK_LLM_PROVIDER) {
    return 'York LLM';
  }
  return `${pick.provider}/${pick.modelId}`;
}

export { AUTO_MODEL_ID, isAutoModelId };
