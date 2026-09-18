import { describe, expect, it } from 'vitest';
import {
  resolveHubOAuthRedirectUrl,
  VITE_DEV_FRONTEND_OAUTH_PORT,
} from '../../shared/auth-config';

describe('resolveHubOAuthRedirectUrl', () => {
  it('uses explicit redirect in Vite dev', () => {
    expect(
      resolveHubOAuthRedirectUrl({
        explicitRedirect: `http://127.0.0.1:${VITE_DEV_FRONTEND_OAUTH_PORT}/auth/callback`,
        viteDevServerUrl: 'http://127.0.0.1:6767',
      })
    ).toBe(`http://127.0.0.1:${VITE_DEV_FRONTEND_OAUTH_PORT}/auth/callback`);
  });

  it('coerces packaged away from Vite dev port 6767 to desktop default', () => {
    expect(
      resolveHubOAuthRedirectUrl({
        explicitRedirect: 'http://127.0.0.1:6767/auth/callback',
        isPackaged: true,
      })
    ).toBe('http://127.0.0.1:19892/auth/callback');
  });

  it('keeps custom loopback port when not 6767', () => {
    expect(
      resolveHubOAuthRedirectUrl({
        explicitRedirect: 'http://127.0.0.1:19892/auth/callback',
      })
    ).toBe('http://127.0.0.1:19892/auth/callback');
  });

  it('derives from frontend URL when no explicit redirect', () => {
    expect(
      resolveHubOAuthRedirectUrl({
        frontendUrl: 'http://127.0.0.1:6767',
        isPackaged: true,
      })
    ).toBe('http://127.0.0.1:19892/auth/callback');
  });

  it('preserves localhost in explicit redirect for Cognito redirect_uri match', () => {
    expect(
      resolveHubOAuthRedirectUrl({
        explicitRedirect: 'http://localhost:6767/auth/callback',
        viteDevServerUrl: 'http://127.0.0.1:6767',
      })
    ).toBe('http://localhost:6767/auth/callback');
  });

  it('keeps :6767 in unpackaged dev even without VITE_DEV_SERVER_URL', () => {
    expect(
      resolveHubOAuthRedirectUrl({
        explicitRedirect: 'http://127.0.0.1:6767/auth/callback',
        isPackaged: false,
      })
    ).toBe('http://127.0.0.1:6767/auth/callback');
  });
});
