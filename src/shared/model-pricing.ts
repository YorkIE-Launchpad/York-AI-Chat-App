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

/** Catalog row chosen for a usage POST. `modelId` is the exact Hub `id`. */
export interface HubCatalogUsageMatch {
  modelId: string;
  provider: string;
  /** Null when the matched row has no input/output rate. */
  pricing: ModelPricing | null;
}

interface IndexedCatalogRow {
  id: string;
  provider: string;
  pricing: ModelPricing | null;
  /** Other spellings of this same id. Does not include the exact id. */
  aliases: Set<string>;
}

/** Every row from the latest GET /api/ai-governance/models, including unpriced ones. */
let catalogRows: IndexedCatalogRow[] = [];

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

/** `Google` / `gemini` are one provider. Other values are lowercased as Hub sent them. */
function normalizeCatalogProvider(provider: string): string {
  const lower = provider.trim().toLowerCase();
  return lower === 'google' ? 'gemini' : lower;
}

/** Same-id spellings: own-vendor prefix, Claude dash/dot, and a trailing snapshot date. */
function aliasesForCatalogId(id: string, provider: string): Set<string> {
  const exact = id.trim().toLowerCase();
  const aliases = new Set<string>();
  const add = (value: string) => {
    const next = value.trim().toLowerCase();
    if (next && next !== exact) aliases.add(next);
  };

  let bare = exact;
  const slash = exact.indexOf('/');
  if (slash >= 0) {
    const prefix = exact.slice(0, slash);
    const rest = exact.slice(slash + 1);
    if (rest && normalizeCatalogProvider(prefix) === provider) {
      bare = rest;
      add(rest);
    }
  }

  const bareForms = new Set<string>([bare]);
  const undated = bare.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  if (undated !== bare) bareForms.add(undated);
  for (const form of [...bareForms]) {
    if (!form.startsWith('claude-')) continue;
    const dotted = form.replace(/-(\d+)-(\d+)$/, '-$1.$2');
    const dashed = form.replace(/-(\d+)\.(\d+)$/, '-$1-$2');
    if (dotted !== form) bareForms.add(dotted);
    if (dashed !== form) bareForms.add(dashed);
  }

  const prefixes = new Set<string>([provider]);
  if (provider === 'gemini') prefixes.add('google');
  for (const form of bareForms) {
    add(form);
    for (const prefix of prefixes) add(`${prefix}/${form}`);
  }
  return aliases;
}

function indexCatalogRow(row: HubCatalogPriceRow): IndexedCatalogRow | null {
  const id = (row.id || '').trim();
  const provider = normalizeCatalogProvider(row.provider || '');
  if (!id || !provider) return null;
  return {
    id,
    provider,
    pricing: pricingFromRow(row),
    aliases: aliasesForCatalogId(id, provider),
  };
}

/**
 * Replace the in-memory Hub catalog from fetched rows.
 * Unpriced rows stay so an exact id still wins over a different model's rates.
 */
export function replaceHubModelPricing(models: HubCatalogPriceRow[]): void {
  const next: IndexedCatalogRow[] = [];
  for (const row of models) {
    const indexed = indexCatalogRow(row);
    if (indexed) next.push(indexed);
  }
  catalogRows = next;
}

/** Clear the Hub price map (tests). */
export function clearHubModelPricing(): void {
  catalogRows = [];
}

function snapshotStripped(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
}

function narrowByProvider(rows: IndexedCatalogRow[], provider: string): IndexedCatalogRow[] {
  if (rows.length <= 1) return rows;
  const want = normalizeCatalogProvider(provider);
  if (!want) return rows;
  const matched = rows.filter((row) => row.provider === want);
  return matched.length === 1 ? matched : rows;
}

function uniqueRows(rows: IndexedCatalogRow[]): IndexedCatalogRow[] {
  const seen = new Set<string>();
  const out: IndexedCatalogRow[] = [];
  for (const row of rows) {
    const key = `${row.provider}\0${row.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Pick the catalog row for a runtime model.
 * Exact id wins. Otherwise one same-id alias. Zero or several aliases → null.
 */
export function resolveHubCatalogUsage(
  provider: string,
  modelId: string
): HubCatalogUsageMatch | null {
  const raw = modelId.trim().toLowerCase();
  if (!raw || catalogRows.length === 0) return null;

  const exact = narrowByProvider(
    uniqueRows(catalogRows.filter((row) => row.id.toLowerCase() === raw)),
    provider
  );
  if (exact.length === 1) return toUsageMatch(exact[0]);
  if (exact.length > 1) return null;

  const stripped = snapshotStripped(raw);
  if (stripped !== raw) {
    const dated = narrowByProvider(
      uniqueRows(catalogRows.filter((row) => row.id.toLowerCase() === stripped)),
      provider
    );
    if (dated.length === 1) return toUsageMatch(dated[0]);
    if (dated.length > 1) return null;
  }

  const aliasHits = uniqueRows(
    catalogRows.filter(
      (row) => row.aliases.has(raw) || (stripped !== raw && row.aliases.has(stripped))
    )
  );
  if (aliasHits.length === 1) return toUsageMatch(aliasHits[0]);
  return null;
}

function toUsageMatch(row: IndexedCatalogRow): HubCatalogUsageMatch {
  return { modelId: row.id, provider: row.provider, pricing: row.pricing };
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

/** Resolve Hub catalog pricing; null when the model has no indexed rates or the match is ambiguous. */
export function resolveModelPricing(provider: string, modelId: string): ModelPricing | null {
  return resolveHubCatalogUsage(provider, modelId)?.pricing ?? null;
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
    if (!(key in row)) continue;
    const value = row[key];
    if (value === null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
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
