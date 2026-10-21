import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../src/main/auth/oauth-external-browser', () => ({
  openOAuthInExternalBrowser: vi.fn(),
}));

import { createOAuthCallbackServer, withOAuthState } from '../src/main/auth/hub-oauth';

type Listener = Awaited<ReturnType<typeof createOAuthCallbackServer>>;
let listener: Listener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

async function start(): Promise<Listener> {
  listener = await createOAuthCallbackServer('http://127.0.0.1:0/auth/callback', 5_000);
  return listener;
}

function callback(l: Listener, params: Record<string, string>): Promise<Response> {
  const url = new URL(l.redirectUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetch(url);
}

describe('Hub OAuth loopback callback state', () => {
  it('generates an unguessable per-flow state', async () => {
    const l = await start();
    expect(l.state.length).toBeGreaterThanOrEqual(40);
  });

  it('accepts the code only when state matches', async () => {
    const l = await start();
    const res = await callback(l, { code: 'real-code', state: l.state });
    expect(res.status).toBe(200);
    await expect(l.waitForCode()).resolves.toBe('real-code');
  });

  it('ignores callbacks with missing or wrong state and still accepts the real one', async () => {
    const l = await start();
    const codePromise = l.waitForCode();

    expect((await callback(l, { code: 'attacker-code' })).status).toBe(400);
    expect((await callback(l, { code: 'attacker-code', state: 'forged' })).status).toBe(400);
    expect((await callback(l, { error: 'access_denied', state: 'forged' })).status).toBe(400);

    expect((await callback(l, { code: 'real-code', state: l.state })).status).toBe(200);
    await expect(codePromise).resolves.toBe('real-code');
  });

  it('escapes provider error text in the failure page', async () => {
    const l = await start();
    const codePromise = l.waitForCode();
    codePromise.catch(() => {});
    const res = await callback(l, {
      error: 'x',
      error_description: '<script>alert(1)</script>',
      state: l.state,
    });
    const body = await res.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
    await expect(codePromise).rejects.toThrow('alert(1)');
  });

  it('withOAuthState overrides any upstream state and keeps other params', () => {
    const out = new URL(
      withOAuthState('https://auth.example/oauth2/authorize?client_id=abc&state=hub', 'mine')
    );
    expect(out.searchParams.get('state')).toBe('mine');
    expect(out.searchParams.get('client_id')).toBe('abc');
  });
});
