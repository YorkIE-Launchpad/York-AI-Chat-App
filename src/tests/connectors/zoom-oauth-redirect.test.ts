import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('Zoom OAuth redirect env', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.ZOOM_OAUTH_REDIRECT_URI;
    delete process.env.VITE_ZOOM_OAUTH_REDIRECT_URI;
    delete process.env.CONNECTOR_OAUTH_CALLBACK_PORT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads ZOOM_OAUTH_REDIRECT_URI from env', async () => {
    process.env.ZOOM_OAUTH_REDIRECT_URI = 'https://backend.example/oauth/zoom/callback';
    const { authConfig } = await import('../../shared/auth-config');
    expect(authConfig.zoomOauthRedirectUri).toBe('https://backend.example/oauth/zoom/callback');
  });

  it('returns undefined when Zoom redirect env is missing', async () => {
    const { authConfig } = await import('../../shared/auth-config');
    expect(authConfig.zoomOauthRedirectUri).toBeUndefined();
  });

  it('defaults connector OAuth callback port to 19891', async () => {
    const { authConfig } = await import('../../shared/auth-config');
    expect(authConfig.connectorOauthCallbackPort).toBe(19891);
    expect(authConfig.connectorOauthRedirectUri).toBe('http://127.0.0.1:19891/callback');
  });

  it('uses 127.0.0.1 loopback for Slack/Gmail/Drive connector redirect', async () => {
    process.env.CONNECTOR_OAUTH_CALLBACK_PORT = '19891';
    const { authConfig } = await import('../../shared/auth-config');
    expect(authConfig.connectorOauthRedirectUri).toBe('http://127.0.0.1:19891/callback');
  });
});
