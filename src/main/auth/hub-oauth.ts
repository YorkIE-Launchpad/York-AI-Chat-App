import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authConfig } from '../../shared/auth-config';
import { parseHubAuthResponse } from './hub-parse';
import { log } from '../utils/logger';
import type { AuthOAuthDebugInfo } from '../../shared/auth-types';
import { closeOAuthBrowserWindow, openOAuthBrowserWindow } from './oauth-browser-window';
import {
  ensureOAuthCodeRelayServer,
  getOAuthRelayBaseUrl,
  registerOAuthRelayDeliverer,
  isOAuthRelayListening,
} from './oauth-relay';

export const HUB_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export interface HubOAuthCallbackResult {
  parsed: NonNullable<ReturnType<typeof parseHubAuthResponse>>;
  redirectUri: string;
}

function normalizeLoopbackHost(hostname: string): string {
  return hostname === 'localhost' ? '127.0.0.1' : hostname;
}

function loopbackHostsMatch(a: string, b: string): boolean {
  const normalize = (host: string) =>
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
      ? '127.0.0.1'
      : host;
  return normalize(a) === normalize(b);
}

function redirectUrlUsesViteDevServer(redirectUrl: string): boolean {
  const viteDev = process.env.VITE_DEV_SERVER_URL?.trim();
  if (!viteDev) return false;
  try {
    const redirect = new URL(redirectUrl);
    const vite = new URL(viteDev);
    const redirectPath = redirect.pathname.replace(/\/$/, '') || '/';
    const samePort =
      (redirect.port || (redirect.protocol === 'https:' ? '443' : '80')) ===
      (vite.port || (vite.protocol === 'https:' ? '443' : '80'));
    return (
      loopbackHostsMatch(redirect.hostname, vite.hostname) &&
      samePort &&
      redirectPath === '/auth/callback'
    );
  } catch {
    return false;
  }
}

/** Success page for loopback OAuth — tries hard to close (works in Electron; best-effort in system browsers). */
export function buildOAuthSuccessHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  <p>${body}</p>
  <script>
    (function () {
      function attemptClose() {
        try { window.open('', '_self'); } catch (e) {}
        try { window.close(); } catch (e) {}
      }
      attemptClose();
      setTimeout(attemptClose, 100);
      setTimeout(attemptClose, 500);
      setTimeout(attemptClose, 1200);
    })();
  </script>
</body></html>`;
}

export function initHubOAuthRelay(): void {
  ensureOAuthCodeRelayServer();
  registerOAuthRelayDeliverer((code) => submitPendingOAuthCode(code));
}

let pendingViteOAuth: {
  redirectUri: string;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

export function submitViteOAuthCode(code: string): boolean {
  return submitPendingOAuthCode(code);
}

function submitPendingOAuthCode(code: string): boolean {
  if (!pendingViteOAuth) return false;
  clearTimeout(pendingViteOAuth.timer);
  pendingViteOAuth.resolve(code);
  pendingViteOAuth = null;
  closeOAuthBrowserWindow();
  return true;
}

function waitForViteOAuthCode(redirectUri: string): Promise<string> {
  if (pendingViteOAuth) {
    clearTimeout(pendingViteOAuth.timer);
    pendingViteOAuth.reject(new Error('OAuth sign-in was restarted'));
    pendingViteOAuth = null;
  }
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingViteOAuth) {
        pendingViteOAuth = null;
        reject(new Error('OAuth sign-in timed out'));
      }
    }, HUB_OAUTH_CALLBACK_TIMEOUT_MS);
    pendingViteOAuth = { redirectUri, resolve, reject, timer };
  });
}

function createOAuthCallbackServer(
  redirectUrl: string,
  timeoutMs: number
): Promise<{
  redirectUrl: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  const redirect = new URL(redirectUrl);
  if (redirect.pathname.replace(/\/$/, '') !== '/auth/callback') {
    return Promise.reject(
      new Error(`OAuth redirect path must be /auth/callback, got ${redirect.pathname}`)
    );
  }
  const host = normalizeLoopbackHost(redirect.hostname);
  if (host !== '127.0.0.1' && host !== '::1') {
    return Promise.reject(
      new Error(
        `OAuth redirect host must be localhost or 127.0.0.1 for desktop loopback, got ${redirect.hostname}`
      )
    );
  }
  const port = redirect.port ? Number(redirect.port) : redirect.protocol === 'https:' ? 443 : 80;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(404);
      response.end();
      return;
    }

    const parsedUrl = new URL(request.url ?? '/', redirectUrl);

    if (parsedUrl.pathname.replace(/\/$/, '') !== '/auth/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const authorizationCode = parsedUrl.searchParams.get('code');
    const error = parsedUrl.searchParams.get('error');
    const errorDescription = parsedUrl.searchParams.get('error_description');

    if (settled) {
      response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('OAuth callback already handled.');
      return;
    }

    if (authorizationCode) {
      settled = true;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(buildOAuthSuccessHtml('Sign-in complete', 'You can return to York WorkOS now.'));
      resolveCode(authorizationCode);
      // Close Electron OAuth window as soon as the code arrives (system browsers ignore window.close).
      closeOAuthBrowserWindow();
      void closeServer(server);
      return;
    }

    const failureMessage = error
      ? `OAuth authorization failed: ${errorDescription || error}`
      : 'OAuth authorization failed: missing authorization code';

    settled = true;
    response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<html><body><h1>Sign-in failed</h1><p>${failureMessage}</p></body></html>`);
    rejectCode(new Error(failureMessage));
    void closeServer(server);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address();
      const boundPort = bound && typeof bound === 'object' ? (bound as AddressInfo).port : port;
      const boundRedirect = `http://127.0.0.1:${boundPort}/auth/callback`;
      log('[Auth] Hub OAuth loopback redirect URL:', boundRedirect);

      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectCode(new Error('OAuth sign-in timed out'));
          void closeServer(server);
        }
      }, timeoutMs);

      const close = async (): Promise<void> => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await closeServer(server);
      };

      resolve({
        redirectUrl: boundRedirect,
        waitForCode: () =>
          codePromise.finally(() => {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
          }),
        close,
      });
    });
  });
}

export function buildGoogleOAuthStartApiUrl(redirectUrl: string): string {
  return `${authConfig.hubApiUrl}/api/auth/google?redirect_url=${encodeURIComponent(redirectUrl)}`;
}

export async function getOAuthDebugInfo(
  rendererOAuthRedirectUrl?: string | null
): Promise<AuthOAuthDebugInfo> {
  const oauthRedirectUrl = authConfig.hubOAuthRedirectUrl;
  const viteDevServerUrl = process.env.VITE_DEV_SERVER_URL?.trim() || null;
  const callbackMode = redirectUrlUsesViteDevServer(oauthRedirectUrl)
    ? 'vite-callback-relay'
    : 'loopback';
  const googleOAuthStartApiUrl = buildGoogleOAuthStartApiUrl(oauthRedirectUrl);

  let googleAuthUrl: string | null = null;
  let googleAuthUrlError: string | null = null;
  let cognitoRedirectUri: string | null = null;
  try {
    googleAuthUrl = await fetchHubGoogleAuthUrl(oauthRedirectUrl);
    try {
      cognitoRedirectUri = new URL(googleAuthUrl).searchParams.get('redirect_uri');
    } catch {
      cognitoRedirectUri = null;
    }
  } catch (error) {
    googleAuthUrlError = error instanceof Error ? error.message : String(error);
  }

  const rendererUrl = rendererOAuthRedirectUrl?.trim() || null;
  const redirectUrlMismatch = Boolean(rendererUrl && rendererUrl !== oauthRedirectUrl);

  return {
    hubApiUrl: authConfig.hubApiUrl,
    oauthRedirectUrl,
    rendererOAuthRedirectUrl: rendererUrl,
    redirectUrlMismatch,
    callbackMode,
    viteDevServerUrl,
    googleOAuthStartApiUrl,
    googleAuthUrl,
    googleAuthUrlError,
    cognitoRedirectUri,
    oauthRelayBaseUrl: getOAuthRelayBaseUrl(),
    oauthRelayListening: isOAuthRelayListening(),
    browserRelayPostUrl: 'http://localhost:6767/vecos-oauth-relay/relay (via Vite proxy)',
  };
}

export async function fetchHubGoogleAuthUrl(redirectUrl: string): Promise<string> {
  const apiUrl = buildGoogleOAuthStartApiUrl(redirectUrl);
  const res = await fetch(apiUrl);
  const json = (await res.json()) as { data?: { url?: string }; url?: string };
  const authUrl = json?.data?.url ?? json?.url;
  if (!authUrl) {
    throw new Error('Invalid response from sign-in service');
  }
  return authUrl;
}

export async function exchangeHubAuthCode(
  code: string,
  redirectUri: string
): Promise<NonNullable<ReturnType<typeof parseHubAuthResponse>>> {
  const url = new URL(`${authConfig.hubApiUrl}/api/auth/callback`);
  url.searchParams.set('code', code);
  url.searchParams.set('redirect_uri', redirectUri);
  const res = await fetch(url.toString());
  const data = await res.json();
  const parsed = parseHubAuthResponse(data);
  if (!parsed) {
    const errBody = data as { message?: string; error?: string };
    throw new Error(errBody?.message || errBody?.error || 'Unexpected response from Hub');
  }
  return parsed;
}

/** Full Hub Google OAuth — redirect URL matches Launchpad config (not a random port). */
export async function runHubGoogleOAuthFlow(): Promise<HubOAuthCallbackResult> {
  const redirectUrl = authConfig.hubOAuthRedirectUrl;
  log('[Auth] Hub OAuth redirect URL (Launchpad-compatible):', redirectUrl);

  if (redirectUrlUsesViteDevServer(redirectUrl)) {
    ensureOAuthCodeRelayServer();
    const authUrl = await fetchHubGoogleAuthUrl(redirectUrl);
    openOAuthBrowserWindow(authUrl);
    try {
      const code = await waitForViteOAuthCode(redirectUrl);
      const parsed = await exchangeHubAuthCode(code, redirectUrl);
      return { parsed, redirectUri: redirectUrl };
    } finally {
      closeOAuthBrowserWindow();
    }
  }

  const listener = await createOAuthCallbackServer(redirectUrl, HUB_OAUTH_CALLBACK_TIMEOUT_MS);
  try {
    const authUrl = await fetchHubGoogleAuthUrl(redirectUrl);
    // Prefer an Electron window so we can auto-close after success.
    // System browsers block window.close() on tabs not opened by script.
    openOAuthBrowserWindow(authUrl);
    const code = await listener.waitForCode();
    const parsed = await exchangeHubAuthCode(code, redirectUrl);
    return { parsed, redirectUri: redirectUrl };
  } finally {
    closeOAuthBrowserWindow();
    await listener.close();
  }
}

export async function hubLogoutRequest(accessToken: string, refreshToken?: string): Promise<void> {
  if (!accessToken) return;
  try {
    await fetch(`${authConfig.hubApiUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: refreshToken ? JSON.stringify({ refreshToken }) : '{}',
    });
  } catch {
    // best effort
  }
}

export type HubRefreshFailureReason = 'invalid_grant' | 'transient' | 'unknown';

export type HubRefreshTokensResult =
  | {
      ok: true;
      tokens: {
        idToken?: string;
        accessToken?: string;
        refreshToken?: string;
      };
    }
  | {
      ok: false;
      reason: HubRefreshFailureReason;
    };

function extractHubRefreshRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const root = data as { data?: Record<string, unknown> };
  const body = root.data ?? (data as Record<string, unknown>);
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function looksLikeInvalidGrantMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid') ||
    lower.includes('expired') ||
    lower.includes('revoked') ||
    lower.includes('not authorized') ||
    lower.includes('unauthorized')
  );
}

/** Classify a Hub /api/auth/refresh HTTP response (pure; used by hubRefreshTokens and tests). */
export function interpretHubRefreshHttpResponse(
  status: number,
  data: unknown
): HubRefreshTokensResult {
  const record = extractHubRefreshRecord(data);
  const idToken = (record.idToken ?? record.id_token) as string | undefined;
  const accessToken = (record.accessToken ?? record.access_token) as string | undefined;
  const newRefresh = (record.refreshToken ?? record.refresh_token) as string | undefined;
  const message = String(
    record.message ?? record.error ?? record.errorMessage ?? record.error_description ?? ''
  );

  if (status === 401 || status === 403) {
    return { ok: false, reason: 'invalid_grant' };
  }

  if (status >= 500) {
    return { ok: false, reason: 'transient' };
  }

  if (status >= 200 && status < 300) {
    if (!idToken && !accessToken) {
      return {
        ok: false,
        reason: looksLikeInvalidGrantMessage(message) ? 'invalid_grant' : 'unknown',
      };
    }
    return {
      ok: true,
      tokens: { idToken, accessToken, refreshToken: newRefresh },
    };
  }

  // 4xx other than 401/403 — usually bad refresh token
  if (status === 400 || looksLikeInvalidGrantMessage(message)) {
    return { ok: false, reason: 'invalid_grant' };
  }

  return { ok: false, reason: 'unknown' };
}

export async function hubRefreshTokens(
  refreshToken: string,
  email: string
): Promise<HubRefreshTokensResult> {
  const controller = new AbortController();
  const timeoutMs = 12_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${authConfig.hubApiUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken, email }),
      signal: controller.signal,
    });

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      if (res.status >= 500 || res.status === 0) {
        return { ok: false, reason: 'transient' };
      }
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        return { ok: false, reason: 'invalid_grant' };
      }
      return { ok: false, reason: res.ok ? 'unknown' : 'transient' };
    }

    return interpretHubRefreshHttpResponse(res.status, data);
  } catch (error) {
    if (
      (error instanceof Error && error.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'AbortError')
    ) {
      return { ok: false, reason: 'transient' };
    }
    return { ok: false, reason: 'transient' };
  } finally {
    clearTimeout(timeoutId);
  }
}
