import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { logWarn } from './safe-log.js';

const DEFAULT_LOCAL_CALLBACK = 'http://127.0.0.1:19891/callback';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Electron loopback target for the OAuth code handoff.
 * Must NEVER be the public `/oauth/zoom/callback` bridge URL — that causes an
 * infinite reload loop (POST fails → location.replace back to the same page).
 */
export function resolveZoomOauthLocalCallbackUrl(
  raw: string | undefined,
  localPort = '19891'
): string {
  const fallback = `http://127.0.0.1:${localPort}/callback`;
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fallback;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const isLoopbackHost =
    host === '127.0.0.1' || host === 'localhost' || host === 'zoom-dev.york.ie';
  const looksLikePublicBridge =
    path === '/oauth/zoom/callback' ||
    path.endsWith('/oauth/zoom/callback') ||
    parsed.protocol === 'https:';

  if (!isLoopbackHost || looksLikePublicBridge) {
    logWarn(
      '[york-ie-backend] ZOOM_OAUTH_LOCAL_CALLBACK_URL must be the Electron loopback ' +
        `(e.g. ${fallback}), not the public Zoom redirect. Ignoring: ${trimmed}`
    );
    return fallback;
  }

  return trimmed;
}

/** HTML shown when Zoom Marketplace / app env points at bare `/callback`. */
export function buildZoomOauthMisconfiguredRedirectHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Wrong Zoom redirect URI</title></head>
<body>
  <h1>Wrong Zoom redirect URI</h1>
  <p>This path (<code>/callback</code>) is not the Zoom OAuth bridge.</p>
  <p>Set <code>ZOOM_OAUTH_REDIRECT_URI</code> and the Zoom Marketplace Redirect URL to:</p>
  <p><code>/oauth/zoom/callback</code> on this backend (for example
  <code>https://&lt;york-backend&gt;/oauth/zoom/callback</code>).</p>
  <p>You can close this window and fix the URI, then try Connect Zoom again.</p>
</body></html>`;
}

/**
 * HTML bridge: Zoom redirects here (public HTTPS), then we hand the code to
 * the local Electron connector listener on 127.0.0.1:19891.
 */
export function buildZoomOauthBridgeHtml(input: {
  code?: string;
  state?: string;
  error?: string;
  localCallbackUrl?: string;
}): string {
  const localCallback = resolveZoomOauthLocalCallbackUrl(input.localCallbackUrl);
  const error = input.error?.trim() || '';
  const code = input.code?.trim() || '';
  const state = input.state?.trim() || '';

  if (error) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Zoom connect failed</title></head>
<body>
  <h1>Zoom connect failed</h1>
  <p>${escapeHtml(error)}</p>
  <p>You can close this window and return to York.</p>
</body></html>`;
  }

  if (!code || !state) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Zoom connect failed</title></head>
<body>
  <h1>Zoom connect failed</h1>
  <p>Missing authorization code or state.</p>
  <p>Start Connect Zoom from the York app, then try again.</p>
</body></html>`;
  }

  const getUrl = `${localCallback}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connecting Zoom…</title></head>
<body>
  <h1>Connecting Zoom…</h1>
  <p id="status">Handing off to York. Keep this window open for a moment.</p>
  <script>
    (function () {
      var code = ${escapeJsString(code)};
      var state = ${escapeJsString(state)};
      var postUrl = ${escapeJsString(localCallback)};
      var getUrl = ${escapeJsString(getUrl)};
      var statusEl = document.getElementById('status');
      var settled = false;

      function attemptClose() {
        try { window.open('', '_self'); } catch (e) {}
        try { window.close(); } catch (e) {}
      }

      function showOk() {
        if (statusEl) statusEl.textContent = 'Connected. You can close this window and return to York.';
        attemptClose();
        setTimeout(attemptClose, 100);
        setTimeout(attemptClose, 500);
        setTimeout(attemptClose, 1200);
      }

      function showFail(msg) {
        if (statusEl) statusEl.textContent = msg;
      }

      function fallbackRedirect() {
        if (settled) return;
        settled = true;
        // Never reload this public bridge page — that loops forever.
        if (getUrl.indexOf('/oauth/zoom/callback') !== -1) {
          showFail('Misconfigured handoff URL. York should receive the code at http://127.0.0.1:19891/callback. Keep the app open and try Connect Zoom again.');
          return;
        }
        window.location.replace(getUrl);
      }

      // Guard: if env pointed the handoff at this same public page, skip fetch and fail clearly.
      try {
        var herePath = window.location.pathname.replace(/\\/$/, '');
        var target = new URL(postUrl);
        var targetPath = target.pathname.replace(/\\/$/, '');
        if (
          (window.location.origin === target.origin && herePath === targetPath) ||
          targetPath.indexOf('/oauth/zoom/callback') !== -1
        ) {
          showFail('Backend ZOOM_OAUTH_LOCAL_CALLBACK_URL points at the public bridge. It must be http://127.0.0.1:19891/callback.');
          return;
        }
      } catch (e) {}

      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
        fallbackRedirect();
      }, 2500);

      fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, state: state }),
        signal: controller ? controller.signal : undefined
      }).then(function (res) {
        clearTimeout(timer);
        if (res.ok) {
          settled = true;
          showOk();
          return;
        }
        fallbackRedirect();
      }).catch(function () {
        clearTimeout(timer);
        fallbackRedirect();
      });
    })();
  </script>
</body></html>`;
}

export function createZoomOauthCallbackRouter(): Router {
  const router = createRouter();
  const localPort = process.env.CONNECTOR_OAUTH_CALLBACK_PORT?.trim() || '19891';
  const localCallbackUrl = resolveZoomOauthLocalCallbackUrl(
    process.env.ZOOM_OAUTH_LOCAL_CALLBACK_URL,
    localPort
  );

  router.get('/callback', (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error =
      typeof req.query.error === 'string'
        ? req.query.error
        : typeof req.query.error_description === 'string'
          ? req.query.error_description
          : undefined;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(
      buildZoomOauthBridgeHtml({
        code,
        state,
        error,
        localCallbackUrl,
      })
    );
  });

  return router;
}

/** Public hint when Marketplace / app env uses bare `/callback` instead of `/oauth/zoom/callback`. */
export function createZoomOauthMisconfiguredRedirectRouter(): Router {
  const router = createRouter();
  router.get('/callback', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).send(buildZoomOauthMisconfiguredRedirectHtml());
  });
  return router;
}
