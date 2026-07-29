import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildZoomOauthBridgeHtml } from './zoom-oauth-callback.js';

describe('buildZoomOauthBridgeHtml', () => {
  it('renders error page when Zoom returns an error', () => {
    const html = buildZoomOauthBridgeHtml({ error: 'access_denied' });
    assert.match(html, /Zoom connect failed/);
    assert.match(html, /access_denied/);
  });

  it('renders missing-code page when code or state absent', () => {
    const html = buildZoomOauthBridgeHtml({ code: 'abc' });
    assert.match(html, /Missing authorization code or state/);
  });

  it('embeds code and state and posts to local callback', () => {
    const html = buildZoomOauthBridgeHtml({
      code: 'auth-code',
      state: 'state-xyz',
      localCallbackUrl: 'http://127.0.0.1:6789/callback',
    });
    assert.match(html, /Connecting Zoom/);
    assert.match(html, /auth-code/);
    assert.match(html, /state-xyz/);
    assert.match(html, /127\.0\.0\.1:6789\/callback/);
    assert.match(html, /method: 'POST'/);
    assert.match(html, /location\.replace/);
  });
});
