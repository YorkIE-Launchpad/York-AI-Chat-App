import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
  /** URI registered with the OAuth provider (authorize + token exchange). */
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

/**
 * Desktop OAuth for Slack / Gmail / Drive / Zoom.
 * Serializes flows and reclaims the fixed callback port so Connect Drive after Gmail works.
 *
 * @param redirectUri Optional provider redirect_uri (e.g. Zoom public backend or hosts-mapped URI).
 *   Local listener always binds 127.0.0.1:CONNECTOR_OAUTH_CALLBACK_PORT for code delivery.
 */
export async function runDesktopOAuthFlow(options: {
  authorizeUrl: string;
  clientId: string;
  scopes: string[];
  extraAuthorizeParams?: Record<string, string>;
  /** OAuth redirect_uri for authorize + token exchange. Defaults to loopback connector URI. */
  redirectUri?: string;
  timeoutMs?: number;
}): Promise<OAuthAuthorizationResult> {
  const run = async (): Promise<OAuthAuthorizationResult> => {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const state = toBase64Url(randomBytes(24));
    const codeVerifier = toBase64Url(randomBytes(48));
    const codeChallenge = sha256Base64Url(codeVerifier);
    const providerRedirectUri = options.redirectUri?.trim() || authConfig.connectorOauthRedirectUri;

    await closeActiveListener();
    const listener = await createOAuthListener(providerRedirectUri);
    activeListener = listener;

    const authUrl = new URL(options.authorizeUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', options.clientId);
    authUrl.searchParams.set('redirect_uri', providerRedirectUri);
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
        redirectUri: providerRedirectUri,
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

async function createOAuthListener(providerRedirectUri: string): Promise<ActiveOAuthListener> {
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

  const handleCallbackPayload = (
    res: ServerResponse,
    payload: { code?: string; state?: string; error?: string },
    asJson: boolean
  ) => {
    const error = payload.error?.trim() ?? '';
    const code = payload.code?.trim() ?? '';
    const state = payload.state?.trim() ?? '';

    if (error) {
      if (asJson) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error }));
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildSuccessHtml('OAuth failed', `Authorization failed: ${error}`));
      }
      settleReject(new Error(`OAuth authorization failed: ${error}`));
      closeOAuthBrowserWindow();
      return;
    }

    if (!code || !state) {
      if (asJson) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing code or state' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildSuccessHtml('OAuth failed', 'Missing authorization code.'));
      }
      settleReject(new Error('OAuth callback missing authorization code or state'));
      closeOAuthBrowserWindow();
      return;
    }

    if (asJson) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildSuccessHtml('Connected', 'You can close this window and return to York.'));
    }
    settleResolve({ code, state });
    closeOAuthBrowserWindow();
  };

  const port = authConfig.connectorOauthCallbackPort;

  server = createServer((req, res) => {
    const requestUrl = req.url ? new URL(req.url, 'http://127.0.0.1') : null;
    if (requestUrl?.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    // CORS preflight from the public Zoom bridge page.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.method === 'POST') {
      void (async () => {
        try {
          const body = (await readJsonBody(req)) as {
            code?: string;
            state?: string;
            error?: string;
          } | null;
          handleCallbackPayload(
            res,
            {
              code: body?.code,
              state: body?.state,
              error: body?.error,
            },
            true
          );
        } catch {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        }
      })();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    handleCallbackPayload(
      res,
      {
        code: requestUrl.searchParams.get('code') ?? undefined,
        state: requestUrl.searchParams.get('state') ?? undefined,
        error: requestUrl.searchParams.get('error') ?? undefined,
      },
      false
    );
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
    redirectUri: providerRedirectUri,
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
