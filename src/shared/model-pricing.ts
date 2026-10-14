/**
 * List-price lookup for Hub usage cost when pi-ai reports zero cost
 * (models newer than the pi-ai registry run as synthetic models with cost 0).
 *
 * Rates are USD per 1M tokens from the bundled list-price snapshot for the
 * York catalog. Pure — safe for MCP subprocesses.
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

/** Charged for paid models with no snapshot price (claude-opus-4.5 rates). */
export const DEFAULT_MODEL_PRICING: ModelPricing = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

/** Snapshot of list prices (2026-09-26), keyed by `vendor/model` id. */
const PRICING_SNAPSHOT: Record<string, ModelPricing> = {
  'anthropic/claude-fable-5.1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'anthropic/claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'anthropic/claude-opus-5.5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'anthropic/claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-opus-4.8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-opus-4.7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-opus-4.6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-opus-4.5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'anthropic/claude-sonnet-4.6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'anthropic/claude-haiku-5.5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longContext: {
      minPromptTokens: 100000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
    },
  },
  'anthropic/claude-haiku-4.5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'openai/gpt-5.6-luna': {
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    longContext: {
      minPromptTokens: 272000,
      input: 0.4,
      output: 1.8,
      cacheRead: 0.04,
      cacheWrite: 0.5,
    },
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
  // OpenAI API pricing page (2026-09-26); output = image output.
  'openai/gpt-image-2.5-flare': { input: 5, output: 30, cacheRead: 1.25, imageInput: 8 },
  'openai/gpt-image-2.5-sunburst': { input: 5, output: 30, cacheRead: 1.25, imageInput: 8 },
};

/** `gpt-image-2.5-flare-2026-09-08` → `gpt-image-2.5-flare`. */
function stripDatedSnapshot(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/** `claude-opus-4-8` / `claude-haiku-4-5-20251001` → `claude-opus-4.8` / `claude-haiku-4.5`. */
function normalizeClaudeId(id: string): string {
  return id.replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

/** Id-prefix / provider aliases → vendor namespace. */
const VENDOR_ALIASES: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  gemini: 'google',
  moonshotai: 'moonshotai',
  moonshot: 'moonshotai',
};

/** Vendor for a bare model id (by family), else from the route provider. */
function inferVendor(bare: string, provider: string): string | null {
  if (bare.startsWith('claude-')) return 'anthropic';
  if (bare.startsWith('gemini-') || bare.startsWith('gemma-')) return 'google';
  if (/^(gpt-|o\d|chatgpt-)/.test(bare)) return 'openai';
  if (bare.startsWith('kimi-')) return 'moonshotai';
  return VENDOR_ALIASES[provider] ?? null;
}

/** Vendor-specific id normalization so bare / prefixed / dated / dashed ids all meet. */
function normalizeBareId(vendor: string, bare: string): string {
  if (vendor === 'anthropic') return normalizeClaudeId(bare);
  return stripDatedSnapshot(bare);
}

/**
 * Candidate pricing keys for a (provider, model) pair, most specific first.
 * Accepts bare (`claude-opus-4-8`) or vendor-prefixed (`anthropic/claude-opus-4.8`) ids.
 */
export function pricingKeysForModel(provider: string, modelId: string): string[] {
  const id = modelId.trim().toLowerCase();
  const prov = provider.trim().toLowerCase();
  if (!id) return [];
  const keys: string[] = [];
  const add = (key: string) => {
    if (key && !keys.includes(key)) keys.push(key);
  };

  const slash = id.indexOf('/');
  const prefix = slash >= 0 ? id.slice(0, slash) : '';
  const bare = slash >= 0 ? id.slice(slash + 1) : id;
  if (prefix) add(id);

  const vendor = (prefix && VENDOR_ALIASES[prefix]) || (prefix ? prefix : inferVendor(bare, prov));
  if (!vendor) return keys;
  add(`${vendor}/${normalizeBareId(vendor, bare)}`);
  add(`${vendor}/${bare}`);
  return keys;
}

/** Resolve list pricing; null when the model is unknown. */
export function resolveModelPricing(provider: string, modelId: string): ModelPricing | null {
  for (const key of pricingKeysForModel(provider, modelId)) {
    const hit = PRICING_SNAPSHOT[key];
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
