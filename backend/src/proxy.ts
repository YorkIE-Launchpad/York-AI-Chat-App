import type { IncomingMessage } from 'node:http';
import type { Request, Response } from 'express';
import { getProviderApiKey, type BackendProvider } from './models.js';

const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-beta',
]);

/** Node fetch auto-decompresses; these must not be forwarded with the plain body. */
const STRIP_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'content-encoding',
  'content-length',
]);

export interface ProviderTarget {
  provider: BackendProvider;
  upstreamOrigin: string;
  /** Path prefix on our server (e.g. /anthropic) */
  mountPath: string;
}

function buildUpstreamUrl(req: Request, target: ProviderTarget): string {
  const suffix = req.url || '/';
  const path = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${target.upstreamOrigin}${path}`;
}

function copyRequestHeaders(req: IncomingMessage, extra: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return headers;
}

function applyProviderAuth(provider: BackendProvider, headers: Headers): void {
  const apiKey = getProviderApiKey(provider);
  if (!apiKey) return;

  switch (provider) {
    case 'anthropic':
      headers.set('x-api-key', apiKey);
      headers.set('anthropic-version', headers.get('anthropic-version') || '2023-06-01');
      break;
    case 'openai':
    case 'openrouter':
      headers.set('authorization', `Bearer ${apiKey}`);
      break;
    case 'gemini':
      // Gemini often uses query key; also set header for REST variants
      headers.set('x-goog-api-key', apiKey);
      break;
    default:
      break;
  }
}

function appendGeminiKeyToUrl(url: string, provider: BackendProvider): string {
  if (provider !== 'gemini') return url;
  const apiKey = getProviderApiKey('gemini');
  if (!apiKey) return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has('key')) {
    parsed.searchParams.set('key', apiKey);
  }
  return parsed.toString();
}

export async function proxyToProvider(
  req: Request,
  res: Response,
  target: ProviderTarget
): Promise<void> {
  const apiKey = getProviderApiKey(target.provider);
  if (!apiKey) {
    res.status(503).json({
      error: `Provider ${target.provider} is not configured. Set ${target.provider.toUpperCase()}_API_KEY in backend/.env`,
    });
    return;
  }

  let upstreamUrl = buildUpstreamUrl(req, target);
  upstreamUrl = appendGeminiKeyToUrl(upstreamUrl, target.provider);

  const headers = copyRequestHeaders(req, {});
  applyProviderAuth(target.provider, headers);

  const method = req.method || 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  let body: Buffer | undefined;
  if (hasBody) {
    body = await readRequestBody(req);
    if (body.length > 0) {
      headers.set('content-length', String(body.length));
    }
  }

  const requestBody = hasBody && body ? new Uint8Array(body).slice().buffer : undefined;

  const abort = new AbortController();
  const onClientGone = (): void => {
    if (!abort.signal.aborted) abort.abort();
  };
  req.on('close', onClientGone);
  req.on('aborted', onClientGone);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: requestBody,
      signal: abort.signal,
    });
  } catch (err) {
    req.off('close', onClientGone);
    req.off('aborted', onClientGone);
    if (abort.signal.aborted) {
      if (!res.headersSent) res.status(499).end();
      else res.end();
      return;
    }
    throw err;
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
  res.flushHeaders();

  if (!upstream.body) {
    req.off('close', onClientGone);
    req.off('aborted', onClientGone);
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      if (abort.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const ok = res.write(Buffer.from(value));
        if (!ok) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error(`[proxy] ${target.provider} stream error:`, err);
    }
    await reader.cancel().catch(() => undefined);
  } finally {
    req.off('close', onClientGone);
    req.off('aborted', onClientGone);
    if (!res.writableEnded) res.end();
  }
}

function readRequestBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
