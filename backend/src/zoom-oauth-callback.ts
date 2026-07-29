import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';

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
 * HTML bridge: Zoom redirects here (public HTTPS), then we hand the code to
 * the local Electron connector listener on 127.0.0.1:19891.
 */
export function buildZoomOauthBridgeHtml(input: {
  code?: string;
  state?: string;
  error?: string;
  localCallbackUrl?: string;
}): string {
  const localCallback = input.localCallbackUrl || DEFAULT_LOCAL_CALLBACK;
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
        window.location.replace(getUrl);
      }

      fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, state: state })
      }).then(function (res) {
        if (res.ok) {
          showOk();
          return;
        }
        fallbackRedirect();
      }).catch(function () {
        fallbackRedirect();
      });
    })();
  </script>
</body></html>`;
}

export function createZoomOauthCallbackRouter(): Router {
  const router = createRouter();
  const localPort = process.env.CONNECTOR_OAUTH_CALLBACK_PORT?.trim() || '19891';
  const localCallbackUrl =
    process.env.ZOOM_OAUTH_LOCAL_CALLBACK_URL?.trim() || `http://127.0.0.1:${localPort}/callback`;

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
