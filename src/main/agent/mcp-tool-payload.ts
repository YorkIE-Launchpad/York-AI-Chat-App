/**
 * @module main/agent/mcp-tool-payload
 *
 * Lean MCP tool args + lossless model-facing compression (prune empties → TOON)
 * with progressive spillover paging when results still exceed the soft budget.
 */
import { createHash } from 'node:crypto';
import { encode } from '@toon-format/toon';

/** Soft char budget for model-facing tool results (gateway body protection). */
export const MCP_TOOL_RESULT_MAX_CHARS = 100_000;

/** Target size for page-1 spillover content (leaves room for inventory footer). */
export const MCP_TOOL_RESULT_PAGE_TARGET_CHARS = 80_000;

/** Default limit injected when schema exposes a limit-like property and model omitted it. */
export const MCP_DEFAULT_LIST_LIMIT = 100;

const LIMIT_PROPERTY_NAMES = new Set(['limit', 'pageSize', 'page_size', 'maxResults']);

const ANALYTICS_DESCRIPTION_NUDGE =
  ' Prefer filters and field projection. Pass only required params plus the filters you need. Avoid unbounded org-wide dumps.';

const spilloverCache = new Map<string, unknown>();

export type McpInputSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyOptionalValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (isRecord(value) && Object.keys(value).length === 0) return true;
  return false;
}

/**
 * Drop empty optional args and inject conservative list limits when the schema
 * exposes limit/pageSize/page_size/maxResults and the model omitted them.
 */
export function leanMcpToolArgs(
  args: Record<string, unknown> | null | undefined,
  inputSchema?: McpInputSchema | null
): Record<string, unknown> {
  const properties = inputSchema?.properties ?? {};
  const required = new Set(inputSchema?.required ?? []);
  const source = args && typeof args === 'object' ? args : {};
  const lean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (!required.has(key) && isEmptyOptionalValue(value)) {
      continue;
    }
    lean[key] = value;
  }

  for (const propName of LIMIT_PROPERTY_NAMES) {
    if (!(propName in properties)) continue;
    if (propName in lean) continue;
    lean[propName] = MCP_DEFAULT_LIST_LIMIT;
  }

  return lean;
}

/**
 * Append a short guidance suffix for list/analytics/summary tools.
 */
export function augmentMcpToolDescription(name: string, description: string): string {
  const base = (description || '').trim();
  const haystack = `${name} ${base}`.toLowerCase();
  const looksListHeavy =
    /(^|__)list_/.test(name.toLowerCase()) ||
    /_analytics/.test(haystack) ||
    /_summaries/.test(haystack) ||
    /\banalytics\b/.test(haystack) ||
    /\bsummaries\b/.test(haystack);

  if (!looksListHeavy) {
    return base || description;
  }
  if (base.includes('Avoid unbounded org-wide dumps')) {
    return base;
  }
  return `${base || description}${ANALYTICS_DESCRIPTION_NUDGE}`;
}

/**
 * Recursively remove null/undefined/empty strings/empty arrays/empty objects.
 * Keeps 0 and false.
 */
export function pruneEmptyValues(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  if (Array.isArray(value)) {
    const pruned = value.map((item) => pruneEmptyValues(item)).filter((item) => item !== undefined);
    return pruned;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const pruned = pruneEmptyValues(nested);
      if (pruned === undefined) continue;
      if (Array.isArray(pruned) && pruned.length === 0) continue;
      if (isRecord(pruned) && Object.keys(pruned).length === 0) continue;
      out[key] = pruned;
    }
    return out;
  }
  return value;
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function collectTopLevelKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const first = value[0];
    return isRecord(first) ? Object.keys(first) : [];
  }
  if (isRecord(value)) {
    return Object.keys(value);
  }
  return [];
}

function countTopLevelItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested) && nested.length > 0) {
        return nested.length;
      }
    }
    return Object.keys(value).length;
  }
  return 1;
}

const SIGNED_URL_PARAM_PATTERN =
  /[?&](X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|GoogleAccessId|Signature|sig|se|sp)=/i;

/**
 * Strip query strings from presigned URLs (S3/GCS/Azure SAS). The tokens are
 * kilobytes each, expire within hours, and carry no meaning for the model.
 */
export function elideSignedUrls(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!/^https?:\/\//i.test(value) || !SIGNED_URL_PARAM_PATTERN.test(value)) return value;
    const queryStart = value.indexOf('?');
    return queryStart === -1 ? value : value.slice(0, queryStart);
  }
  if (Array.isArray(value)) {
    return value.map((item) => elideSignedUrls(item));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = elideSignedUrls(nested);
    }
    return out;
  }
  return value;
}

type TruncatedArray = { path: string; shown: number; total: number };

function maxArrayLength(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((max, item) => Math.max(max, maxArrayLength(item)), value.length);
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>(
      (max, nested) => Math.max(max, maxArrayLength(nested)),
      0
    );
  }
  return 0;
}

/** Cap every array in the tree (top-level and nested) to `cap` items. */
function capArrays(
  value: unknown,
  cap: number,
  path = '',
  truncated: TruncatedArray[] = []
): { page: unknown; truncated: TruncatedArray[] } {
  if (Array.isArray(value)) {
    if (value.length > cap) {
      truncated.push({ path: path || '$', shown: cap, total: value.length });
    }
    const page = value
      .slice(0, cap)
      .map((item, index) => capArrays(item, cap, `${path}[${index}]`, truncated).page);
    return { page, truncated };
  }
  if (isRecord(value)) {
    const page: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      page[key] = capArrays(nested, cap, path ? `${path}.${key}` : key, truncated).page;
    }
    return { page, truncated };
  }
  return { page: value, truncated };
}

/** Collapse per-row paths (`a[0].b`, `a[1].b`) so the inventory stays short. */
function summarizeTruncations(truncated: TruncatedArray[], limit = 12): TruncatedArray[] {
  const byPath = new Map<string, TruncatedArray>();
  for (const entry of truncated) {
    const key = entry.path.replace(/\[\d+\]/g, '[]');
    const existing = byPath.get(key);
    if (!existing || entry.total > existing.total) {
      byPath.set(key, { ...entry, path: key });
    }
  }
  return [...byPath.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

function encodeToon(value: unknown): string {
  return encode(value);
}

function cacheSpillover(value: unknown): string {
  const json = JSON.stringify(value);
  const cacheId = createHash('sha256').update(json).digest('hex').slice(0, 16);
  spilloverCache.set(cacheId, value);
  // Bound cache size roughly (keep newest).
  if (spilloverCache.size > 32) {
    const oldest = spilloverCache.keys().next().value;
    if (oldest) spilloverCache.delete(oldest);
  }
  return cacheId;
}

/** Test helper: clear spillover cache. */
export function clearMcpToolResultSpilloverCache(): void {
  spilloverCache.clear();
}

/** Test helper: read spillover cache entry. */
export function getMcpToolResultSpillover(cacheId: string): unknown | undefined {
  return spilloverCache.get(cacheId);
}

function encodeStructured(value: unknown): { format: 'toon' | 'json'; body: string } {
  try {
    return { format: 'toon', body: encodeToon(value) };
  } catch {
    return { format: 'json', body: JSON.stringify(value) };
  }
}

function formatStructuredDocument(
  format: 'toon' | 'json',
  body: string,
  inventory?: Record<string, unknown>
): string {
  const header = `format: ${format}`;
  if (!inventory) {
    return `${header}\n${body}`;
  }
  const inventoryLines = Object.entries(inventory)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  return `${header}\n${inventoryLines}\n---\n${body}`;
}

/**
 * Compress structured JSON for model context: prune empties → TOON.
 * If still over budget, return page 1 + inventory (full data cached).
 * Non-JSON text is returned unchanged.
 */
export function compressToolResultTextForModel(
  text: string,
  options?: { maxChars?: number; pageTargetChars?: number }
): string {
  const maxChars = options?.maxChars ?? MCP_TOOL_RESULT_MAX_CHARS;
  const pageTarget = options?.pageTargetChars ?? MCP_TOOL_RESULT_PAGE_TARGET_CHARS;

  const parsed = tryParseJson(text);
  if (parsed === undefined) {
    return text;
  }

  const pruned = pruneEmptyValues(parsed);
  if (pruned === undefined) {
    return 'format: toon\n';
  }

  const full = encodeStructured(pruned);
  const fullDoc = formatStructuredDocument(full.format, full.body);
  if (fullDoc.length <= maxChars) {
    return fullDoc;
  }

  // Spillover: keep full payload in cache, elide signed URLs, then cap every
  // array (including nested ones) to the largest size that fits the page target.
  const cacheId = cacheSpillover(pruned);
  const slim = elideSignedUrls(pruned);

  const slimEncoded = encodeStructured(slim);
  const slimDoc = formatStructuredDocument(slimEncoded.format, slimEncoded.body);
  if (slimDoc.length <= maxChars) {
    return slimDoc;
  }

  const keys = collectTopLevelKeys(slim);
  const totalItems = countTopLevelItems(slim);
  const buildDoc = (cap: number): string => {
    const { page, truncated } = capArrays(slim, cap);
    const encoded = encodeStructured(page);
    const inventory = {
      paged: true,
      totalItems,
      keys,
      cacheId,
      nextOffset: truncated.length > 0 ? cap : null,
      truncatedArrays: summarizeTruncations(truncated),
      hint: `Result exceeded model budget. Every list is capped at ${cap} items; full data kept. Re-call the same tool with tighter filters/limit/offset (or a narrower type/scope) to fetch more.`,
    };
    return formatStructuredDocument(encoded.format, encoded.body, inventory);
  };

  let lo = 1;
  let hi = Math.max(1, maxArrayLength(slim));
  let bestDoc = buildDoc(1);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const doc = buildDoc(mid);
    if (doc.length <= pageTarget) {
      bestDoc = doc;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestDoc.length > maxChars) {
    const marker = '\n…[truncated: result still exceeded model budget at 1 item per list]';
    return bestDoc.slice(0, Math.max(0, maxChars - marker.length)) + marker;
  }
  return bestDoc;
}
