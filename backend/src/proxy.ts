import http from 'node:http';
import https from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { Request, Response } from 'express';
import { getProviderApiKey, type BackendProvider } from './models.js';

const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  // Forced to identity below — do not forward client gzip preferences.
  'accept-encoding',
]);

/** Hop-by-hop / length headers Express must not forward when we stream. */
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

function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
      return;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      return;
    }
    out[key] = [String(existing), value];
  });
  return out;
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

function enableNoDelay(socket: { setNoDelay?: (v: boolean) => void } | null | undefined): void {
  try {
    socket?.setNoDelay?.(true);
  } catch {
    // ignore sockets that do not support setNoDelay
  }
}

function requestBodyLooksLikeStream(body: Buffer | undefined): boolean {
  if (!body || body.length === 0) return false;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

function isStreamingResponse(
  contentType: string | string[] | undefined,
  body: Buffer | undefined
): boolean {
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  if (typeof type === 'string' && type.includes('text/event-stream')) {
    return true;
  }
  return requestBodyLooksLikeStream(body);
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
  // Avoid gzip so SSE frames are not re-buffered by decompression.
  headers.set('accept-encoding', 'identity');

  const method = req.method || 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  let body: Buffer | undefined;
  if (hasBody) {
    body = await readRequestBody(req);
    if (body.length > 0) {
      headers.set('content-length', String(body.length));
    }
  }

  const parsedUrl = new URL(upstreamUrl);
  headers.set('host', parsedUrl.host);

  enableNoDelay(req.socket);

  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const nodeHeaders = headersToOutgoing(headers);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let abortRequested = false;
    const upstream: { req?: ClientRequest; res?: IncomingMessage } = {};

    const cleanup = (): void => {
      req.off('close', onClientGone);
      req.off('aborted', onClientGone);
    };

    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err && !abortRequested) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve();
    };

    const destroyUpstream = (): void => {
      abortRequested = true;
      upstream.res?.destroy();
      upstream.req?.destroy();
    };

    const onClientGone = (): void => {
      destroyUpstream();
      if (!res.writableEnded) {
        if (!res.headersSent) res.status(499).end();
        else res.end();
      }
      finish();
    };

    req.on('close', onClientGone);
    req.on('aborted', onClientGone);

    const options: RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method,
      headers: nodeHeaders,
    };

    const upstreamReq = transport.request(options, (incoming) => {
      upstream.res = incoming;
      enableNoDelay(incoming.socket);

      if (abortRequested) {
        incoming.destroy();
        finish();
        return;
      }

      const streaming = isStreamingResponse(incoming.headers['content-type'], body);

      res.status(incoming.statusCode || 502);
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        res.setHeader(key, value);
      }

      if (streaming) {
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.removeHeader('content-length');
      }

      res.flushHeaders();

      incoming.on('data', (chunk: Buffer) => {
        if (abortRequested || res.writableEnded) return;
        const ok = res.write(chunk);
        if (!ok) {
          incoming.pause();
          res.once('drain', () => {
            if (!abortRequested) incoming.resume();
          });
        }
      });

      incoming.on('end', () => {
        if (!res.writableEnded) res.end();
        finish();
      });

      incoming.on('error', (err) => {
        if (!abortRequested) {
          console.error(`[proxy] ${target.provider} stream error:`, err);
        }
        if (!res.writableEnded) res.end();
        finish(abortRequested ? undefined : err);
      });
    });
    upstream.req = upstreamReq;

    upstreamReq.on('socket', (socket) => {
      enableNoDelay(socket);
    });

    upstreamReq.on('error', (err) => {
      if (abortRequested) {
        if (!res.headersSent) res.status(499).end();
        else if (!res.writableEnded) res.end();
        finish();
        return;
      }
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Upstream request failed',
          message: err instanceof Error ? err.message : String(err),
        });
        finish();
        return;
      }
      if (!res.writableEnded) res.end();
      finish(err);
    });

    if (hasBody && body && body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
}

function readRequestBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
