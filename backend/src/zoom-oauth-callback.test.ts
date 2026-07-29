import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildZoomOauthBridgeHtml,
  buildZoomOauthMisconfiguredRedirectHtml,
  resolveZoomOauthLocalCallbackUrl,
} from './zoom-oauth-callback.js';

describe('resolveZoomOauthLocalCallbackUrl', () => {
  it('defaults to 127.0.0.1 loopback', () => {
    assert.equal(resolveZoomOauthLocalCallbackUrl(undefined), 'http://127.0.0.1:19891/callback');
    assert.equal(resolveZoomOauthLocalCallbackUrl(''), 'http://127.0.0.1:19891/callback');
  });

  it('keeps valid loopback URLs', () => {
    assert.equal(
      resolveZoomOauthLocalCallbackUrl('http://127.0.0.1:19891/callback'),
      'http://127.0.0.1:19891/callback'
    );
    assert.equal(
      resolveZoomOauthLocalCallbackUrl('http://zoom-dev.york.ie:19891/callback'),
      'http://zoom-dev.york.ie:19891/callback'
    );
  });

  it('rejects public bridge URL that would loop', () => {
    assert.equal(
      resolveZoomOauthLocalCallbackUrl('https://api.vecos.yorkdevs.link/oauth/zoom/callback'),
      'http://127.0.0.1:19891/callback'
    );
  });

  it('rejects https and non-loopback hosts', () => {
    assert.equal(
      resolveZoomOauthLocalCallbackUrl('https://example.com/callback'),
      'http://127.0.0.1:19891/callback'
    );
    assert.equal(
      resolveZoomOauthLocalCallbackUrl('http://example.com:19891/callback'),
      'http://127.0.0.1:19891/callback'
    );
  });
});

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
      localCallbackUrl: 'http://127.0.0.1:19891/callback',
    });
    assert.match(html, /Connecting Zoom/);
    assert.match(html, /auth-code/);
    assert.match(html, /state-xyz/);
    assert.match(html, /127\.0\.0\.1:19891\/callback/);
    assert.match(html, /method: 'POST'/);
    assert.match(html, /location\.replace/);
  });

  it('rewrites a looping public bridge handoff URL to loopback', () => {
    const html = buildZoomOauthBridgeHtml({
      code: 'auth-code',
      state: 'state-xyz',
      localCallbackUrl: 'https://api.vecos.yorkdevs.link/oauth/zoom/callback',
    });
    assert.match(html, /127\.0\.0\.1:19891\/callback/);
    assert.doesNotMatch(html, /api\.vecos\.yorkdevs\.link/);
  });
});

describe('buildZoomOauthMisconfiguredRedirectHtml', () => {
  it('tells operators to use /oauth/zoom/callback', () => {
    const html = buildZoomOauthMisconfiguredRedirectHtml();
    assert.match(html, /Wrong Zoom redirect URI/);
    assert.match(html, /\/oauth\/zoom\/callback/);
  });
});
