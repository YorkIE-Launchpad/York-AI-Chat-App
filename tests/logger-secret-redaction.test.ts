import { describe, expect, it } from 'vitest';
import { isSensitiveLogKey, redactForLogging, scrubSecretStrings } from '../src/main/utils/logger';

describe('logger secret redaction', () => {
  it('redacts sensitive object string fields', () => {
    const redacted = redactForLogging({
      apiKey: 'sk-ant-secret-value',
      accessToken: 'ya29.secret',
      refreshToken: '1//refresh',
      openRouterUserApiKey: 'sk-or-user-key',
      authorization: 'Bearer abc.def.ghi',
      clientSecret: 'zoom-client-secret',
      appSecret: 'feishu-secret',
      password: 'super-secret',
      provider: 'anthropic',
    }) as Record<string, unknown>;

    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.accessToken).toBe('[REDACTED]');
    expect(redacted.refreshToken).toBe('[REDACTED]');
    expect(redacted.openRouterUserApiKey).toBe('[REDACTED]');
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted.clientSecret).toBe('[REDACTED]');
    expect(redacted.appSecret).toBe('[REDACTED]');
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.provider).toBe('anthropic');
  });

  it('preserves allowlisted keys that match the token/key pattern', () => {
    const redacted = redactForLogging({
      maxTokens: 8192,
      tokenUsage: { input: 10, output: 20 },
      tokenUse: 'id',
      token_use: 'access',
      expiresIn: 3600,
      expire: 7200,
      apiKeyConfigured: true,
    }) as Record<string, unknown>;

    expect(redacted.maxTokens).toBe(8192);
    expect(redacted.tokenUsage).toEqual({ input: 10, output: 20 });
    expect(redacted.tokenUse).toBe('id');
    expect(redacted.token_use).toBe('access');
    expect(redacted.expiresIn).toBe(3600);
    expect(redacted.expire).toBe(7200);
    expect(redacted.apiKeyConfigured).toBe(true);
  });

  it('redacts nested profile apiKeys', () => {
    const redacted = redactForLogging({
      profiles: {
        anthropic: { apiKey: 'sk-ant-nested', model: 'claude' },
      },
    }) as {
      profiles: { anthropic: { apiKey: string; model: string } };
    };

    expect(redacted.profiles.anthropic.apiKey).toBe('[REDACTED]');
    expect(redacted.profiles.anthropic.model).toBe('claude');
  });

  it('scrubs Bearer tokens, JWTs, and common API key prefixes in free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const text = scrubSecretStrings(
      `auth=Bearer ${jwt} key=sk-ant-abc123 slack=xoxp-1-2-3 google=AIzaSyAbcdef123`
    );

    expect(text).not.toContain(jwt);
    expect(text).not.toContain('sk-ant-abc123');
    expect(text).not.toContain('xoxp-1-2-3');
    expect(text).not.toContain('AIzaSyAbcdef123');
    expect(text).toContain('Bearer [REDACTED]');
    expect(text).toContain('[REDACTED]');
  });

  it('scrubs secrets inside Error messages', () => {
    const err = new Error('upstream rejected Bearer eyJabc.def.ghi');
    const redacted = redactForLogging(err) as { message: string };
    expect(redacted.message).toContain('Bearer [REDACTED]');
    expect(redacted.message).not.toContain('eyJabc.def.ghi');
  });

  it('classifies sensitive vs safe keys', () => {
    expect(isSensitiveLogKey('apiKey')).toBe(true);
    expect(isSensitiveLogKey('access_token')).toBe(true);
    expect(isSensitiveLogKey('x-api-key')).toBe(true);
    expect(isSensitiveLogKey('maxTokens')).toBe(false);
    expect(isSensitiveLogKey('tokenUsage')).toBe(false);
    expect(isSensitiveLogKey('provider')).toBe(false);
  });
});
