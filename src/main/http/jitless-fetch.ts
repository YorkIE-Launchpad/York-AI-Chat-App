import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

type HubHttpInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type HubHttpResponse = {
  ok: boolean;
  status: number;
  header: (name: string) => string | undefined;
  json: <T>() => Promise<T>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type NodeHttpResult = {
  status: number;
  headers: Record<string, string>;
  buffer: Buffer;
  finalUrl: string;
  redirected: boolean;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Node's `http.globalAgent` defaults to a 5s socket timeout. Passing
 * `timeout: undefined` still inherits that. On macOS jitless we replace
 * `fetch` with this Node http client — destroying on the agent timeout
 * aborted York LLM streams whenever TTFT exceeded ~5–8s.
 *
 * `0` disables the socket timeout; callers that need a bound must pass
 * an explicit positive `timeoutMs` (and/or AbortSignal).
 */
function resolveSocketTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.round(timeoutMs);
  }
  return 0;
}

function normalizeHeaders(init?: HeadersInit | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (typeof Headers !== 'undefined' && init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init)) {
    for (const [key, value] of init) out[key] = value;
    return out;
  }
  return { ...(init as Record<string, string>) };
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer;
}

function incomingMessageToHeaderRecord(res: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
  }
  return headers;
}

function buildResponseHeaders(headerMap: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(headerMap)) {
    headers.set(key, value);
  }
  return headers;
}

function statusTextForCode(status: number): string {
  if (status === 200) return 'OK';
  if (status === 201) return 'Created';
  if (status === 204) return 'No Content';
  if (status === 400) return 'Bad Request';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 429) return 'Too Many Requests';
  if (status === 500) return 'Internal Server Error';
  if (status === 502) return 'Bad Gateway';
  if (status === 503) return 'Service Unavailable';
  return String(status);
}

function nodeStreamToWebStream(nodeStream: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (error) => controller.error(error));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

function bufferToWebResponse(result: NodeHttpResult): Response {
  const headers = buildResponseHeaders(result.headers);
  return new Response(new Uint8Array(result.buffer), {
    status: result.status,
    statusText: statusTextForCode(result.status),
    headers,
  });
}

async function encodeRequestBody(
  body: BodyInit | null | undefined,
  headers: Record<string, string>
): Promise<string | Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) {
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return body.toString();
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const boundary = `----JitlessFetch${randomBytes(16).toString('hex')}`;
    const chunks: Buffer[] = [];
    for (const [name, value] of body.entries()) {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      if (typeof File !== 'undefined' && value instanceof File) {
        chunks.push(
          Buffer.from(
            `Content-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`
          )
        );
        chunks.push(Buffer.from(await value.arrayBuffer()));
      } else if (value instanceof Blob) {
        chunks.push(
          Buffer.from(
            `Content-Disposition: form-data; name="${name}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`
          )
        );
        chunks.push(Buffer.from(await value.arrayBuffer()));
      } else {
        chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`));
      }
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    return Buffer.concat(chunks);
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return String(body);
}

function performNodeHttpRequest(
  urlString: string,
  init: HubHttpInit & { maxRedirects?: number; method?: string }
): Promise<NodeHttpResult> {
  const maxRedirects = init.maxRedirects ?? 0;
  const method = (init.method ?? 'GET').toUpperCase();

  const run = (
    currentUrl: string,
    redirectsLeft: number,
    currentMethod: string,
    redirected: boolean
  ): Promise<NodeHttpResult> => {
    const url = new URL(currentUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Promise.reject(new TypeError(`Unsupported URL protocol: ${url.protocol}`));
    }
    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const socketTimeoutMs = resolveSocketTimeoutMs(init.timeoutMs);
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: currentMethod,
          headers: init.headers,
          timeout: socketTimeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const status = res.statusCode ?? 500;
            const headers = incomingMessageToHeaderRecord(res);

            const location = headers.location;
            if (redirectsLeft > 0 && location && REDIRECT_STATUSES.has(status)) {
              const nextUrl = new URL(location, currentUrl).toString();
              const nextMethod =
                status === 303 || status === 301 || status === 302 ? 'GET' : currentMethod;
              void run(nextUrl, redirectsLeft - 1, nextMethod, true).then(resolve, reject);
              return;
            }

            resolve({ status, headers, buffer, finalUrl: currentUrl, redirected });
          });
        }
      );

      const onAbort = () => {
        req.destroy(createAbortError());
      };
      init.signal?.addEventListener('abort', onAbort, { once: true });

      if (socketTimeoutMs > 0) {
        req.on('timeout', () => {
          req.destroy(new Error('Request timed out'));
        });
      }
      req.on('error', (error) => {
        init.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      req.on('close', () => {
        init.signal?.removeEventListener('abort', onAbort);
      });

      if (init.body) req.write(init.body);
      req.end();
    });
  };

  return run(urlString, maxRedirects, method, false);
}

function performNodeHttpFetch(
  urlString: string,
  init: HubHttpInit & { maxRedirects?: number; method?: string }
): Promise<Response> {
  const maxRedirects = init.maxRedirects ?? 5;
  const method = (init.method ?? 'GET').toUpperCase();

  const run = (
    currentUrl: string,
    redirectsLeft: number,
    currentMethod: string,
    redirected: boolean
  ): Promise<Response> => {
    const url = new URL(currentUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Promise.reject(new TypeError(`Unsupported URL protocol: ${url.protocol}`));
    }
    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const socketTimeoutMs = resolveSocketTimeoutMs(init.timeoutMs);
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: currentMethod,
          headers: init.headers,
          timeout: socketTimeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 500;
          const headers = incomingMessageToHeaderRecord(res);
          const location = headers.location;

          if (redirectsLeft > 0 && location && REDIRECT_STATUSES.has(status)) {
            res.resume();
            res.on('end', () => {
              const nextUrl = new URL(location, currentUrl).toString();
              const nextMethod =
                status === 303 || status === 301 || status === 302 ? 'GET' : currentMethod;
              void run(nextUrl, redirectsLeft - 1, nextMethod, true).then(resolve, reject);
            });
            res.on('error', reject);
            return;
          }

          const response = new Response(nodeStreamToWebStream(res), {
            status,
            statusText: statusTextForCode(status),
            headers: buildResponseHeaders(headers),
          });
          Object.defineProperty(response, 'url', { value: currentUrl });
          Object.defineProperty(response, 'redirected', { value: redirected });
          resolve(response);
        }
      );

      const onAbort = () => {
        req.destroy(createAbortError());
      };
      init.signal?.addEventListener('abort', onAbort, { once: true });

      if (socketTimeoutMs > 0) {
        req.on('timeout', () => {
          req.destroy(new Error('Request timed out'));
        });
      }
      req.on('error', (error) => {
        init.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      req.on('close', () => {
        init.signal?.removeEventListener('abort', onAbort);
      });

      if (init.body) req.write(init.body);
      req.end();
    });
  };

  return run(urlString, maxRedirects, method, false);
}

function toHubHttpResponse(result: NodeHttpResult): HubHttpResponse {
  const text = result.buffer.toString('utf8');
  const status = result.status;
  return {
    ok: status >= 200 && status < 300,
    status,
    header: (name: string) => result.headers[name.toLowerCase()],
    json: async <T>() => {
      if (!text.trim()) return {} as T;
      return JSON.parse(text) as T;
    },
    text: async () => text,
    arrayBuffer: async () => bufferToArrayBuffer(result.buffer),
  };
}

/**
 * HTTP(S) via Node core — safe when V8 runs without WebAssembly (jitless on macOS 26+).
 * Defaults to a 30s socket timeout when callers omit `timeoutMs`.
 */
export function hubHttpRequest(urlString: string, init: HubHttpInit = {}): Promise<HubHttpResponse> {
  return performNodeHttpRequest(urlString, {
    ...init,
    timeoutMs: init.timeoutMs ?? 30_000,
  }).then(toHubHttpResponse);
}

async function jitlessFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let urlString: string;
  let method = init?.method ?? 'GET';
  let headers = normalizeHeaders(init?.headers);
  let body: BodyInit | null | undefined = init?.body ?? undefined;
  let signal: AbortSignal | undefined = init?.signal ?? undefined;

  if (typeof Request !== 'undefined' && input instanceof Request) {
    urlString = input.url;
    method = init?.method ?? input.method;
    headers = { ...normalizeHeaders(input.headers), ...headers };
    if (init?.body == null && input.body != null) {
      body = await input.clone().text();
    }
    signal = init?.signal ?? input.signal ?? undefined;
  } else if (input instanceof URL) {
    urlString = input.toString();
  } else {
    urlString = String(input);
  }

  const encodedBody = await encodeRequestBody(body ?? undefined, headers);

  return performNodeHttpFetch(urlString, {
    method,
    headers,
    body: encodedBody,
    signal,
    maxRedirects: 5,
  });
}

let fetchPolyfillInstalled = false;

/** @internal test helper */
export function __resetJitlessFetchInstallForTests(): void {
  fetchPolyfillInstalled = false;
}

/**
 * Replace global fetch when WebAssembly is unavailable (Electron --jitless).
 * Uses native Response/Headers so OpenAI SDK, Hub clients, connectors, etc. stay compatible.
 */
export function installJitlessSafeFetch(): void {
  if (fetchPolyfillInstalled) return;
  if (typeof WebAssembly !== 'undefined') return;
  globalThis.fetch = jitlessFetch as unknown as typeof fetch;
  fetchPolyfillInstalled = true;
}

export { jitlessFetch, bufferToWebResponse };
