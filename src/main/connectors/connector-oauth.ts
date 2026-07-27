import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { authConfig } from '../../shared/auth-config';
import { closeOAuthBrowserWindow, openOAuthBrowserWindow } from '../auth/oauth-browser-window';

function toBase64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sha256Base64Url(input: string): string {
  return toBase64Url(createHash('sha256').update(input).digest());
}

/** Success page for loopback OAuth — tries hard to close (works in Electron; best-effort in system browsers). */
function buildSuccessHtml(title: string, body: string): string {
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

export interface OAuthAuthorizationResult {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

type ActiveOAuthListener = {
  redirectUri: string;
  waitForCode: (expectedState: string, timeoutMs: number) => Promise<string>;
  close: () => Promise<void>;
  cancel: (reason?: Error) => void;
};

/** Only one connector OAuth callback server may bind the fixed redirect port. */
let activeListener: ActiveOAuthListener | null = null;
let oauthFlowChain: Promise<unknown> = Promise.resolve();

async function closeActiveListener(): Promise<void> {
  const previous = activeListener;
  activeListener = null;
  if (!previous) return;
  previous.cancel(new Error('OAuth flow superseded by a new connector connect'));
  await previous.close().catch(() => undefined);
}

/**
 * Desktop loopback OAuth for Slack / Gmail / Drive.
 * Serializes flows and reclaims the fixed callback port so Connect Drive after Gmail works.
 */
export async function runDesktopOAuthFlow(options: {
  authorizeUrl: string;
  clientId: string;
  scopes: string[];
  extraAuthorizeParams?: Record<string, string>;
  timeoutMs?: number;
}): Promise<OAuthAuthorizationResult> {
  const run = async (): Promise<OAuthAuthorizationResult> => {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const state = toBase64Url(randomBytes(24));
    const codeVerifier = toBase64Url(randomBytes(48));
    const codeChallenge = sha256Base64Url(codeVerifier);

    await closeActiveListener();
    const listener = await createOAuthListener();
    activeListener = listener;

    const authUrl = new URL(options.authorizeUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', options.clientId);
    authUrl.searchParams.set('redirect_uri', listener.redirectUri);
    if (options.scopes.length > 0) {
      authUrl.searchParams.set('scope', options.scopes.join(' '));
    }
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    for (const [key, value] of Object.entries(options.extraAuthorizeParams ?? {})) {
      authUrl.searchParams.set(key, value);
    }

    let settled = false;
    try {
      // Prefer an Electron window so we can auto-close after success.
      // System browsers block window.close() on tabs not opened by script.
      openOAuthBrowserWindow(authUrl.toString(), 'Connect', {
        onClosed: () => {
          if (!settled) {
            listener.cancel(new Error('OAuth window closed before authorization completed'));
          }
        },
      });
      const code = await listener.waitForCode(state, timeoutMs);
      settled = true;
      return {
        code,
        codeVerifier,
        redirectUri: listener.redirectUri,
      };
    } finally {
      settled = true;
      closeOAuthBrowserWindow();
      if (activeListener === listener) {
        activeListener = null;
      }
      await listener.close().catch(() => undefined);
    }
  };

  const next = oauthFlowChain.then(run, run);
  oauthFlowChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function createOAuthListener(): Promise<ActiveOAuthListener> {
  let server: Server | null = null;
  let resolveCode: ((payload: { code: string; state: string }) => void) | null = null;
  let rejectCode: ((error: Error) => void) | null = null;
  let settled = false;

  const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const settleReject = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectCode?.(error);
  };

  const settleResolve = (payload: { code: string; state: string }) => {
    if (settled) return;
    settled = true;
    resolveCode?.(payload);
  };

  const port = authConfig.connectorOauthCallbackPort;
  const redirectUri = authConfig.connectorOauthRedirectUri;

  server = createServer((req, res) => {
    const requestUrl = req.url ? new URL(req.url, 'http://127.0.0.1') : null;
    if (requestUrl?.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const code = requestUrl.searchParams.get('code')?.trim() ?? '';
    const state = requestUrl.searchParams.get('state')?.trim() ?? '';
    const error = requestUrl.searchParams.get('error')?.trim() ?? '';

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildSuccessHtml('OAuth failed', `Authorization failed: ${error}`));
      settleReject(new Error(`OAuth authorization failed: ${error}`));
      closeOAuthBrowserWindow();
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildSuccessHtml('OAuth failed', 'Missing authorization code.'));
      settleReject(new Error('OAuth callback missing authorization code or state'));
      closeOAuthBrowserWindow();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildSuccessHtml('Connected', 'You can close this window and return to York.'));
    // Resolve before closing the window so the closed handler does not cancel success.
    settleResolve({ code, state });
    closeOAuthBrowserWindow();
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Connector OAuth callback port ${port} is already in use. Free it or set CONNECTOR_OAUTH_CALLBACK_PORT.`
          )
        );
        return;
      }
      reject(error);
    });
    server!.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    redirectUri,
    waitForCode: async (expectedState: string, timeoutMs: number) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('OAuth timed out waiting for callback')),
          timeoutMs
        );
      });
      try {
        const payload = await Promise.race([codePromise, timeoutPromise]);
        if (payload.state !== expectedState) {
          throw new Error('OAuth state mismatch');
        }
        return payload.code;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    },
    cancel: (reason) => {
      settleReject(reason ?? new Error('OAuth cancelled'));
    },
    close: async () => {
      if (!server) return;
      const closing = server;
      server = null;
      try {
        closing.closeAllConnections?.();
      } catch {
        // ignore — older Node without closeAllConnections
      }
      if (!closing.listening) return;
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
      });
    },
  };
}
