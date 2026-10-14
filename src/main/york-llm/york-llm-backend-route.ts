import { resolveBackendUrl } from '../../shared/backend-config';
import { isYorkLlmHost } from '../../shared/york-llm-config';
import { getBackendAuthHeaders } from '../config/backend-auth';

/**
 * Sends York LLM traffic through the York IE backend, which holds the org-wide
 * queue for the shared llama.cpp slots and the llama.cpp API key.
 *
 * Applied at the fetch layer so every caller (pi-ai, OpenAI SDK, model listing)
 * and every persisted `llm.yorkdevs.link` base URL is covered.
 */

type FetchFn = typeof fetch;

let originalFetch: FetchFn | null = null;

function readEnv(name: string): string {
  return process.env[name]?.trim() || '';
}

/** `YORK_LLM_VIA_BACKEND=0|1` overrides; otherwise on when a backend URL is configured. */
export function shouldRouteYorkLlmViaBackend(): boolean {
  const flag = readEnv('YORK_LLM_VIA_BACKEND').toLowerCase();
  if (flag === '0' || flag === 'false') return false;
  if (flag === '1' || flag === 'true') return true;
  return Boolean(readEnv('YORK_IE_BACKEND_URL'));
}

export function rewriteYorkLlmUrlForBackend(
  url: string,
  backendUrl: string = resolveBackendUrl()
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isYorkLlmHost(parsed.hostname)) return null;
  return `${backendUrl.replace(/\/+$/, '')}/york-llm${parsed.pathname}${parsed.search}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export async function yorkLlmBackendFetch(
  fetchFn: FetchFn,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const target = rewriteYorkLlmUrlForBackend(requestUrl(input));
  if (!target) return fetchFn(input, init);

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  for (const [key, value] of Object.entries(await getBackendAuthHeaders())) {
    headers.set(key, value);
  }

  if (input instanceof Request) {
    return fetchFn(target, {
      method: input.method,
      headers,
      body: input.body,
      signal: init?.signal ?? input.signal,
      duplex: 'half',
    } as RequestInit);
  }
  return fetchFn(target, { ...init, headers });
}

export function installYorkLlmBackendRoute(): void {
  if (originalFetch || !shouldRouteYorkLlmViaBackend()) return;
  const base = globalThis.fetch.bind(globalThis);
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    yorkLlmBackendFetch(base, input, init)) as FetchFn;
}

export function uninstallYorkLlmBackendRoute(): void {
  if (!originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
}
