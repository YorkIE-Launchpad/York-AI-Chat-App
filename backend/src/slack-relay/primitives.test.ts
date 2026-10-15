import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { isEmailAllowed, resolveSlackRelayConfig } from './config.js';
import { chunkText, escapeSlackText } from './sanitize.js';
import { verifySlackSignature } from './signature.js';

const FULL_ENV = {
  SLACK_RELAY_ENABLED: 'true',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'secret',
  SLACK_APP_ID: 'A1',
  SLACK_ALLOWED_TEAM_ID: 'T1',
};

function sign(body: string, timestamp: string, secret = 'secret'): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

describe('slack relay config', () => {
  it('is disabled unless explicitly enabled and fully configured', () => {
    assert.equal(resolveSlackRelayConfig({}), null);
    assert.equal(resolveSlackRelayConfig({ ...FULL_ENV, SLACK_RELAY_ENABLED: 'false' }), null);
    for (const key of [
      'SLACK_BOT_TOKEN',
      'SLACK_SIGNING_SECRET',
      'SLACK_APP_ID',
      'SLACK_ALLOWED_TEAM_ID',
    ]) {
      assert.equal(resolveSlackRelayConfig({ ...FULL_ENV, [key]: '' }), null, key);
    }
    assert.equal(resolveSlackRelayConfig({ ...FULL_ENV, SLACK_BOT_TOKEN: 'xoxp-user' }), null);
    assert.ok(resolveSlackRelayConfig(FULL_ENV));
  });

  it('enforces email domain and optional allowlist', () => {
    const config = resolveSlackRelayConfig(FULL_ENV)!;
    assert.equal(isEmailAllowed('Dev@York.ie', config), true);
    assert.equal(isEmailAllowed('dev@evil.com', config), false);
    assert.equal(isEmailAllowed('dev@york.ie.evil.com', config), false);
    assert.equal(isEmailAllowed('not-an-email', config), false);

    const strict = resolveSlackRelayConfig({
      ...FULL_ENV,
      SLACK_RELAY_ALLOWED_EMAILS: 'a@york.ie',
    })!;
    assert.equal(isEmailAllowed('a@york.ie', strict), true);
    assert.equal(isEmailAllowed('b@york.ie', strict), false);
  });
});

describe('slack signature', () => {
  const now = 1_700_000_000;
  const ts = String(now);
  const body = '{"type":"event_callback"}';

  it('accepts a valid signature', () => {
    assert.equal(
      verifySlackSignature({
        rawBody: body,
        timestamp: ts,
        signature: sign(body, ts),
        signingSecret: 'secret',
        nowSeconds: now,
      }),
      true
    );
  });

  it('rejects tampered body, wrong secret, missing headers, and stale timestamps', () => {
    const sig = sign(body, ts);
    const base = { timestamp: ts, signature: sig, signingSecret: 'secret', nowSeconds: now };
    assert.equal(verifySlackSignature({ ...base, rawBody: body + ' ' }), false);
    assert.equal(verifySlackSignature({ ...base, rawBody: body, signingSecret: 'other' }), false);
    assert.equal(verifySlackSignature({ ...base, rawBody: body, signature: undefined }), false);
    assert.equal(verifySlackSignature({ ...base, rawBody: body, timestamp: undefined }), false);
    assert.equal(verifySlackSignature({ ...base, rawBody: body, nowSeconds: now + 301 }), false);
    assert.equal(verifySlackSignature({ ...base, rawBody: body, signature: 'v0=zz' }), false);
  });
});

describe('slack sanitize', () => {
  it('neutralizes broadcast mentions, user mentions, and links', () => {
    const out = escapeSlackText('<!channel> <!here> <@U123> <https://evil|click> a&b');
    assert.ok(!out.includes('<'));
    assert.ok(!out.includes('>'));
    assert.equal(
      out,
      '&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;https://evil|click&gt; a&amp;b'
    );
  });

  it('chunks long text without losing content', () => {
    const text = 'x'.repeat(10_000);
    const chunks = chunkText(text, 3_800);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every((c) => c.length <= 3_800));
  });
});
