import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSensitiveLogKey, redactForLogging, scrubSecretStrings } from './safe-log.js';

describe('safe-log secret redaction', () => {
  it('redacts sensitive object string fields', () => {
    const redacted = redactForLogging({
      apiKey: 'sk-ant-secret-value',
      accessToken: 'ya29.secret',
      refreshToken: '1//refresh',
      authorization: 'Bearer abc.def.ghi',
      clientSecret: 'zoom-client-secret',
      password: 'super-secret',
      provider: 'anthropic',
    }) as Record<string, unknown>;

    assert.equal(redacted.apiKey, '[REDACTED]');
    assert.equal(redacted.accessToken, '[REDACTED]');
    assert.equal(redacted.refreshToken, '[REDACTED]');
    assert.equal(redacted.authorization, '[REDACTED]');
    assert.equal(redacted.clientSecret, '[REDACTED]');
    assert.equal(redacted.password, '[REDACTED]');
    assert.equal(redacted.provider, 'anthropic');
  });

  it('preserves allowlisted keys that match the token/key pattern', () => {
    const redacted = redactForLogging({
      maxTokens: 8192,
      tokenUsage: { input: 10, output: 20 },
      tokenUse: 'id',
      expiresIn: 3600,
      apiKeyConfigured: true,
    }) as Record<string, unknown>;

    assert.equal(redacted.maxTokens, 8192);
    assert.deepEqual(redacted.tokenUsage, { input: 10, output: 20 });
    assert.equal(redacted.tokenUse, 'id');
    assert.equal(redacted.expiresIn, 3600);
    assert.equal(redacted.apiKeyConfigured, true);
  });

  it('scrubs Bearer tokens, JWTs, and common API key prefixes in free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const text = scrubSecretStrings(
      `auth=Bearer ${jwt} key=sk-or-user-abc slack=xoxb-1-2-3 google=AIzaSyAbcdef123`
    );

    assert.equal(text.includes(jwt), false);
    assert.equal(text.includes('sk-or-user-abc'), false);
    assert.equal(text.includes('xoxb-1-2-3'), false);
    assert.equal(text.includes('AIzaSyAbcdef123'), false);
    assert.match(text, /Bearer \[REDACTED]/);
  });

  it('classifies sensitive vs safe keys', () => {
    assert.equal(isSensitiveLogKey('apiKey'), true);
    assert.equal(isSensitiveLogKey('access_token'), true);
    assert.equal(isSensitiveLogKey('x-api-key'), true);
    assert.equal(isSensitiveLogKey('maxTokens'), false);
    assert.equal(isSensitiveLogKey('tokenUsage'), false);
    assert.equal(isSensitiveLogKey('provider'), false);
  });
});
