/**
 * Hub catalog list-price lookup for usage cost when pi-ai reports zero cost
 * (models newer than the pi-ai registry run as synthetic models with cost 0).
 *
 * Rates are USD per 1M tokens from GET /api/ai-governance/models.
 * Pure — safe for MCP subprocesses.
 */

export interface ModelTokenRates {
  input: number;
  output: number;
  /** USD per 1M cache-read tokens; omitted/undefined treated as 0. */
  cacheRead?: number;
  /** USD per 1M cache-write tokens; omitted/undefined treated as 0. */
  cacheWrite?: number;
}

export type ModelPricing = ModelTokenRates;

export interface ModelUsageCost {
  total: number;
  input: number;
  output: number;
  cached: number;
}

/** One Hub catalog row used to fill the in-memory price map. */
export interface HubCatalogPriceRow {
  id: string;
  provider: string;
  inputPrice?: number | null;
  outputPrice?: number | null;
  cacheReadPrice?: number | null;
  cacheWritePrice?: number | null;
}

/** In-memory Hub catalog rates, keyed by `vendor/model` (and aliases). */
let hubPricingByKey: Record<string, ModelPricing> = {};

function finitePrice(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pricingFromRow(row: HubCatalogPriceRow): ModelPricing | null {
  const input = finitePrice(row.inputPrice);
  const output = finitePrice(row.outputPrice);
  if (input === undefined && output === undefined) return null;
  const cacheRead = finitePrice(row.cacheReadPrice);
  const cacheWrite = finitePrice(row.cacheWritePrice);
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

/**
 * Replace the in-memory Hub price map from catalog rows.
 * Rows without input/output rates are skipped.
 */
export function replaceHubModelPricing(models: HubCatalogPriceRow[]): void {
  const next: Record<string, ModelPricing> = {};
  for (const row of models) {
    const id = (row.id || '').trim();
    const provider = (row.provider || '').trim();
    if (!id || !provider) continue;
    const pricing = pricingFromRow(row);
    if (!pricing) continue;
    for (const key of pricingKeysForModel(provider, id)) {
      next[key] = pricing;
    }
  }
  hubPricingByKey = next;
}

/** Clear the Hub price map (tests). */
export function clearHubModelPricing(): void {
  hubPricingByKey = {};
}

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

/** Resolve Hub catalog pricing; null when the model has no indexed rates. */
export function resolveModelPricing(provider: string, modelId: string): ModelPricing | null {
  for (const key of pricingKeysForModel(provider, modelId)) {
    const hit = hubPricingByKey[key];
    if (hit) return hit;
  }
  return null;
}

/**
 * Cost from pi-style token counts. `input` excludes cache read/write tokens
 * (pi-ai convention), so the four buckets are additive.
 * Image-input tokens are billed at the input rate (Hub has no separate image price).
 * Null/omitted cache rates bill as 0.
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
  const cacheReadRate = pricing.cacheRead ?? 0;
  const cacheWriteRate = pricing.cacheWrite ?? 0;
  const inputCost = (input * pricing.input) / 1e6 + (imageInput * pricing.input) / 1e6;
  const outputCost = (output * pricing.output) / 1e6;
  const cachedCost = (cacheRead * cacheReadRate) / 1e6 + (cacheWrite * cacheWriteRate) / 1e6;
  return {
    total: inputCost + outputCost + cachedCost,
    input: inputCost,
    output: outputCost,
    cached: cachedCost,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nullableNumberField(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (value === null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Unwrap Hub `{ success, data: { models } }` (or bare `{ models }`) into price rows.
 * Electron-free — safe for MCP subprocesses.
 */
export function extractHubCatalogPrices(payload: unknown): HubCatalogPriceRow[] {
  const root = asRecord(payload) || {};
  const data = asRecord(root.data) || root;
  const raw = Array.isArray(data.models) ? data.models : [];
  const rows: HubCatalogPriceRow[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const row = asRecord(entry);
    if (!row) continue;
    const id = stringField(row, 'id', 'model_id');
    const provider = stringField(row, 'provider');
    if (!id || !provider) continue;
    const key = `${provider.toLowerCase()}:${id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id,
      provider,
      inputPrice: nullableNumberField(row, 'input_price', 'inputPrice'),
      outputPrice: nullableNumberField(row, 'output_price', 'outputPrice'),
      cacheReadPrice: nullableNumberField(row, 'cache_read_price', 'cacheReadPrice'),
      cacheWritePrice: nullableNumberField(row, 'cache_write_price', 'cacheWritePrice'),
    });
  }
  return rows;
}

/** Parse Hub models payload and replace the in-memory price map. */
export function replaceHubModelPricingFromPayload(payload: unknown): HubCatalogPriceRow[] {
  const rows = extractHubCatalogPrices(payload);
  replaceHubModelPricing(rows);
  return rows;
}
