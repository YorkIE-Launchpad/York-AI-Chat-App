import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/config/backend-auth', () => ({
  getBackendAuthHeaders: vi.fn(async () => ({
    Authorization: 'Bearer cognito-jwt',
    'x-york-app-version': '9.9.9',
  })),
}));

import {
  rewriteYorkLlmUrlForBackend,
  shouldRouteYorkLlmViaBackend,
  yorkLlmBackendFetch,
} from '../../main/york-llm/york-llm-backend-route';

const BACKEND = 'https://api.example.test';

describe('york-llm-backend-route', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes via backend only when a backend URL is configured, unless overridden', () => {
    vi.stubEnv('YORK_IE_BACKEND_URL', '');
    vi.stubEnv('YORK_LLM_VIA_BACKEND', '');
    expect(shouldRouteYorkLlmViaBackend()).toBe(false);
    vi.stubEnv('YORK_IE_BACKEND_URL', BACKEND);
    expect(shouldRouteYorkLlmViaBackend()).toBe(true);
    vi.stubEnv('YORK_LLM_VIA_BACKEND', '0');
    expect(shouldRouteYorkLlmViaBackend()).toBe(false);
  });

  it('rewrites York LLM urls onto the backend /york-llm route', () => {
    expect(
      rewriteYorkLlmUrlForBackend('http://llm.yorkdevs.link:2222/v1/chat/completions', BACKEND)
    ).toBe(`${BACKEND}/york-llm/v1/chat/completions`);
    expect(
      rewriteYorkLlmUrlForBackend('http://llm.yorkdevs.link:2222/v1/models?x=1', BACKEND)
    ).toBe(`${BACKEND}/york-llm/v1/models?x=1`);
    expect(rewriteYorkLlmUrlForBackend('https://api.openai.com/v1/models', BACKEND)).toBeNull();
  });

  it('replaces the llama.cpp key with Cognito auth and keeps the request intact', async () => {
    vi.stubEnv('YORK_IE_BACKEND_URL', BACKEND);
    const fetchFn = vi.fn(async () => new Response('ok'));
    const signal = new AbortController().signal;
    await yorkLlmBackendFetch(fetchFn, 'http://llm.yorkdevs.link:2222/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer llama-key', 'Content-Type': 'application/json' },
      body: '{"stream":true}',
      signal,
    });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe(`${BACKEND}/york-llm/v1/chat/completions`);
    expect(headers.get('authorization')).toBe('Bearer cognito-jwt');
    expect(headers.get('x-york-app-version')).toBe('9.9.9');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"stream":true}');
    expect(init.signal).toBe(signal);
  });

  it('passes other requests through untouched', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));
    const init = { method: 'GET' };
    await yorkLlmBackendFetch(fetchFn, 'https://api.openai.com/v1/models', init);
    expect(fetchFn).toHaveBeenCalledWith('https://api.openai.com/v1/models', init);
  });
});
