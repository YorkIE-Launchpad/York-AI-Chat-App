/**
 * List-price lookup for Hub usage cost when pi-ai reports zero cost
 * (models newer than the pi-ai registry run as synthetic models with cost 0).
 *
 * Rates are USD per 1M tokens. Source of truth is OpenRouter's public
 * GET /api/v1/models (refreshed at runtime); the snapshot below is the
 * offline fallback for the York catalog. Pure — safe for MCP subprocesses.
 */

export interface ModelTokenRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Image-input tokens (image models bill these above text input). */
  imageInput?: number;
}

export interface ModelPricing extends ModelTokenRates {
  /** Higher tier applied when prompt-side tokens reach minPromptTokens. */
  longContext?: ModelTokenRates & { minPromptTokens: number };
}

export interface ModelUsageCost {
  total: number;
  input: number;
  output: number;
  cached: number;
}

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const PRICING_TTL_MS = 12 * 60 * 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 5000;

const FREE_PRICING: ModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Charged for paid models with no live or snapshot price (claude-opus-4.5 rates). */
export const DEFAULT_MODEL_PRICING: ModelPricing = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

/** Snapshot of OpenRouter list prices (2026-09-26), keyed by OpenRouter model id. */
const PRICING_SNAPSHOT: Record<string, ModelPricing> = {
  'anthropic/claude-fable-5.1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'anthropic/claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'anthropic/claude-opus-5.5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'anthropic/claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-opus-4.8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-opus-4.7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-opus-4.6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-opus-4.5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'anthropic/claude-sonnet-4.6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'anthropic/claude-haiku-4.5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'openai/gpt-5.6-luna': {
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    longContext: { minPromptTokens: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
  },
  'openai/gpt-5.6-terra': {
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    longContext: { minPromptTokens: 272000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
  },
  'openai/gpt-5.6-sol': {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    longContext: { minPromptTokens: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
  },
  'openai/gpt-5.5': {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    longContext: { minPromptTokens: 272000, input: 10, output: 45, cacheRead: 1 },
  },
  'openai/gpt-5.4': {
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    longContext: { minPromptTokens: 272000, input: 5, output: 22.5, cacheRead: 0.5 },
  },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075 },
  'openai/gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175 },
  'openai/o3': { input: 2, output: 8, cacheRead: 0.5 },
  'openai/o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275 },
  'google/gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'google/gemini-3.7-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'google/gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'google/gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15 },
  'google/gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03 },
  'google/gemini-3.1-pro-preview': {
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 0.375,
    longContext: { minPromptTokens: 200000, input: 4, output: 18, cacheRead: 0.4 },
  },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025 },
  'moonshotai/kimi-k3': { input: 3, output: 15, cacheRead: 0.3 },
  // Not listed on OpenRouter — OpenAI API pricing page (2026-09-26); output = image output.
  'openai/gpt-image-2.5-flare': { input: 5, output: 30, cacheRead: 1.25, imageInput: 8 },
  'openai/gpt-image-2.5-sunburst': { input: 5, output: 30, cacheRead: 1.25, imageInput: 8 },
};

let livePricing: Map<string, ModelPricing> | null = null;
let livePricingFetchedAt = 0;
let inflightRefresh: Promise<void> | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** OpenRouter prices are USD-per-token strings; convert to USD per 1M tokens. */
function perMillion(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

function parseRates(row: Record<string, unknown>): ModelTokenRates | null {
  const input = perMillion(row.prompt);
  const output = perMillion(row.completion);
  if (input === undefined || output === undefined) return null;
  const rates: ModelTokenRates = { input, output };
  const cacheRead = perMillion(row.input_cache_read);
  const cacheWrite = perMillion(row.input_cache_write);
  if (cacheRead !== undefined) rates.cacheRead = cacheRead;
  if (cacheWrite !== undefined) rates.cacheWrite = cacheWrite;
  return rates;
}

/** Parse OpenRouter GET /api/v1/models into id → pricing. */
export function parseOpenRouterModelPricing(payload: unknown): Map<string, ModelPricing> {
  const out = new Map<string, ModelPricing>();
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    const row = asRecord(entry);
    const id = typeof row?.id === 'string' ? row.id.trim().toLowerCase() : '';
    const pricingRow = asRecord(row?.pricing);
    if (!id || !pricingRow) continue;
    const base = parseRates(pricingRow);
    if (!base) continue;
    const pricing: ModelPricing = { ...base };
    const override = Array.isArray(pricingRow.overrides) ? asRecord(pricingRow.overrides[0]) : null;
    const minPromptTokens =
      override && typeof override.min_prompt_tokens === 'number' ? override.min_prompt_tokens : 0;
    const overrideRates = override ? parseRates({ ...pricingRow, ...override }) : null;
    if (overrideRates && minPromptTokens > 0) {
      pricing.longContext = { ...overrideRates, minPromptTokens };
    }
    out.set(id, pricing);
  }
  return out;
}

/**
 * Refresh live pricing from OpenRouter (deduped, TTL-cached). Never throws;
 * on failure the snapshot / previous live table stays in use.
 */
export async function ensureModelPricingFresh(options?: {
  fetchFn?: typeof fetch;
  force?: boolean;
}): Promise<void> {
  if (!options?.force && livePricing && Date.now() - livePricingFetchedAt < PRICING_TTL_MS) {
    return;
  }
  if (inflightRefresh) return inflightRefresh;
  const fetchFn = options?.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!fetchFn) return;
  inflightRefresh = (async () => {
    try {
      const res = await fetchFn(OPENROUTER_MODELS_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const parsed = parseOpenRouterModelPricing(await res.json());
      if (parsed.size > 0) {
        livePricing = parsed;
        livePricingFetchedAt = Date.now();
      }
    } catch {
      /* keep snapshot */
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/** Test hook: drop live pricing so only the snapshot is used. */
export function resetModelPricingCache(): void {
  livePricing = null;
  livePricingFetchedAt = 0;
  inflightRefresh = null;
}

/** `gpt-image-2.5-flare-2026-09-08` → `gpt-image-2.5-flare`. */
function stripDatedSnapshot(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/** `claude-opus-4-8` / `claude-haiku-4-5-20251001` → `claude-opus-4.8` / `claude-haiku-4.5`. */
function normalizeClaudeId(id: string): string {
  return id.replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

/** Candidate OpenRouter ids for a (provider, model) pair, most specific first. */
export function pricingKeysForModel(provider: string, modelId: string): string[] {
  const id = modelId.trim().toLowerCase();
  const prov = provider.trim().toLowerCase();
  if (!id) return [];
  const keys: string[] = [];
  const add = (key: string) => {
    if (key && !keys.includes(key)) keys.push(key);
  };

  if (id.includes('/')) {
    const slash = id.indexOf('/');
    const vendor = id.slice(0, slash);
    const bare = id.slice(slash + 1);
    add(id);
    if (vendor === 'anthropic') add(`anthropic/${normalizeClaudeId(bare)}`);
    return keys;
  }

  if (prov === 'anthropic' || id.startsWith('claude-')) {
    add(`anthropic/${normalizeClaudeId(id)}`);
    add(`anthropic/${id}`);
  } else if (prov === 'gemini' || prov === 'google' || id.startsWith('gemini-')) {
    add(`google/${id}`);
  } else if (prov === 'openai' || /^(gpt-|o\d|chatgpt-)/.test(id)) {
    add(`openai/${id}`);
    add(`openai/${stripDatedSnapshot(id)}`);
  } else if (id.startsWith('kimi-')) {
    add(`moonshotai/${id}`);
  }
  return keys;
}

/** Resolve list pricing; null when the model is unknown. */
export function resolveModelPricing(provider: string, modelId: string): ModelPricing | null {
  const lower = modelId.trim().toLowerCase();
  if (lower.endsWith(':free') || lower === 'openrouter/free') return FREE_PRICING;
  for (const key of pricingKeysForModel(provider, modelId)) {
    const hit = livePricing?.get(key) ?? PRICING_SNAPSHOT[key];
    if (hit) return hit;
  }
  return null;
}

/**
 * Cost from pi-style token counts. `input` excludes cache read/write tokens
 * (pi-ai convention), so the four buckets are additive.
 */
export function computeModelUsageCost(
  pricing: ModelPricing,
  tokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    imageInput?: number;
  }
): ModelUsageCost {
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const imageInput = tokens.imageInput ?? 0;
  const promptSide = input + imageInput + cacheRead + cacheWrite;
  const rates: ModelTokenRates =
    pricing.longContext && promptSide >= pricing.longContext.minPromptTokens
      ? pricing.longContext
      : pricing;
  const inputCost =
    (input * rates.input) / 1e6 + (imageInput * (rates.imageInput ?? rates.input)) / 1e6;
  const outputCost = (output * rates.output) / 1e6;
  const cachedCost =
    (cacheRead * (rates.cacheRead ?? rates.input)) / 1e6 +
    (cacheWrite * (rates.cacheWrite ?? rates.input)) / 1e6;
  return {
    total: inputCost + outputCost + cachedCost,
    input: inputCost,
    output: outputCost,
    cached: cachedCost,
  };
}
