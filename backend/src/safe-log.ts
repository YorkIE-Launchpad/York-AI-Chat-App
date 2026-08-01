/**
 * Secret-safe logging for the York IE backend.
 * Mirrors Electron app logger redaction so credentials never hit stdout/stderr.
 */

const REDACTED = '[REDACTED]';

const SAFE_LOG_KEYS = new Set([
  'maxtokens',
  'tokenusage',
  'tokenuse',
  'token_use',
  'inputtokens',
  'outputtokens',
  'prompttokens',
  'completiontokens',
  'totaltokens',
  'expiresin',
  'expire',
  'apikeyconfigured',
]);

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'x-york-openrouter-key',
  'cookie',
  'set-cookie',
]);

const BEARER_SECRET_RE = /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;
const JWT_SECRET_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SK_SECRET_RE = /\bsk-(?:ant-|or-)?[A-Za-z0-9_-]+/g;
const XOX_SECRET_RE = /\bxox[a-z](?:\.[a-z]+)?-[A-Za-z0-9-]+/gi;
const AIZA_SECRET_RE = /\bAIza[A-Za-z0-9_-]+/g;

const MAX_LOG_OBJECT_DEPTH = 4;
const MAX_LOG_OBJECT_KEYS = 40;
const MAX_LOG_ARRAY_ITEMS = 20;

function compactLogKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveLogKey(key: string): boolean {
  const lower = key.toLowerCase();
  const compact = compactLogKey(key);
  if (SAFE_LOG_KEYS.has(lower) || SAFE_LOG_KEYS.has(compact)) {
    return false;
  }
  if (SENSITIVE_HEADER_KEYS.has(lower)) {
    return true;
  }
  if (
    compact.includes('secret') ||
    compact.includes('password') ||
    compact.includes('authorization') ||
    compact === 'cookie' ||
    compact === 'setcookie'
  ) {
    return true;
  }
  if (compact.includes('apikey') || compact.endsWith('userapikey')) {
    return true;
  }
  if (compact.includes('token')) {
    return true;
  }
  return false;
}

export function scrubSecretStrings(text: string): string {
  return text
    .replace(BEARER_SECRET_RE, `Bearer ${REDACTED}`)
    .replace(JWT_SECRET_RE, REDACTED)
    .replace(SK_SECRET_RE, REDACTED)
    .replace(XOX_SECRET_RE, REDACTED)
    .replace(AIZA_SECRET_RE, REDACTED);
}

function normalizeLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) {
      return '[Circular Error]';
    }
    seen.add(value);
    const err = value as Error & { cause?: unknown };
    const extraEntries = Object.entries(err as unknown as Record<string, unknown>).filter(
      ([key]) => !['name', 'message', 'stack', 'cause'].includes(key)
    );
    return {
      name: err.name,
      message: scrubSecretStrings(err.message || ''),
      stack: err.stack ? scrubSecretStrings(err.stack) : undefined,
      cause: err.cause !== undefined ? normalizeLogValue(err.cause, seen, depth + 1) : undefined,
      meta:
        extraEntries.length > 0
          ? normalizeLogValue(Object.fromEntries(extraEntries), seen, depth + 1)
          : undefined,
    };
  }

  if (typeof value === 'string') {
    return scrubSecretStrings(value);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return `${value}n`;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }

  if (depth >= MAX_LOG_OBJECT_DEPTH) {
    return '[Max Depth Reached]';
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => normalizeLogValue(item, seen, depth + 1))
      .concat(
        value.length > MAX_LOG_ARRAY_ITEMS
          ? [`[+${value.length - MAX_LOG_ARRAY_ITEMS} more items]`]
          : []
      );
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular Object]';
    }
    seen.add(value);

    const entries = Object.entries(value as Record<string, unknown>);
    const limitedEntries = entries.slice(0, MAX_LOG_OBJECT_KEYS).map(([key, item]) => {
      if (isSensitiveLogKey(key) && typeof item === 'string') {
        return [key, REDACTED];
      }
      return [key, normalizeLogValue(item, seen, depth + 1)];
    });

    if (entries.length > MAX_LOG_OBJECT_KEYS) {
      limitedEntries.push([
        '__truncated__',
        `[+${entries.length - MAX_LOG_OBJECT_KEYS} more keys]`,
      ]);
    }

    return Object.fromEntries(limitedEntries);
  }

  return scrubSecretStrings(String(value));
}

export function redactForLogging(value: unknown): unknown {
  return normalizeLogValue(value);
}

function prepareLogArgs(args: unknown[]): unknown[] {
  return args.map((arg) => normalizeLogValue(arg));
}

export function log(...args: unknown[]): void {
  console.log(...prepareLogArgs(args));
}

export function logWarn(...args: unknown[]): void {
  console.warn(...prepareLogArgs(args));
}

export function logError(...args: unknown[]): void {
  console.error(...prepareLogArgs(args));
}
