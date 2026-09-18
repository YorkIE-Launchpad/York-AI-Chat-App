import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hubRefreshTokens, interpretHubRefreshHttpResponse } from '../../main/auth/hub-oauth';

const hubHttpRequest = vi.fn();

vi.mock('../../main/auth/hub-http', () => ({
  hubHttpRequest: (...args: unknown[]) => hubHttpRequest(...args),
}));

describe('interpretHubRefreshHttpResponse', () => {
  it('returns tokens on 200 with camelCase fields', () => {
    const result = interpretHubRefreshHttpResponse(200, {
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(result).toEqual({
      ok: true,
      tokens: { idToken: 'id', accessToken: 'access', refreshToken: 'refresh' },
    });
  });

  it('unwraps nested data envelope', () => {
    const result = interpretHubRefreshHttpResponse(200, {
      data: { id_token: 'id', access_token: 'access', refresh_token: 'r2' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.refreshToken).toBe('r2');
    }
  });

  it('treats 401/403 as invalid_grant', () => {
    expect(interpretHubRefreshHttpResponse(401, { error: 'Unauthorized' })).toEqual({
      ok: false,
      reason: 'invalid_grant',
    });
    expect(interpretHubRefreshHttpResponse(403, {})).toEqual({
      ok: false,
      reason: 'invalid_grant',
    });
  });

  it('treats 5xx as transient', () => {
    expect(interpretHubRefreshHttpResponse(503, { message: 'busy' })).toEqual({
      ok: false,
      reason: 'transient',
    });
  });

  it('treats 400 with invalid message as invalid_grant', () => {
    expect(
      interpretHubRefreshHttpResponse(400, { message: 'Refresh token expired or revoked' })
    ).toEqual({ ok: false, reason: 'invalid_grant' });
  });
});

describe('hubRefreshTokens', () => {
  beforeEach(() => {
    hubHttpRequest.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns transient on network failure', async () => {
    hubHttpRequest.mockRejectedValue(new Error('network down'));
    const result = await hubRefreshTokens('rt', 'user@york.ie');
    expect(result).toEqual({ ok: false, reason: 'transient' });
  });

  it('returns invalid_grant on 401', async () => {
    hubHttpRequest.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    });
    const result = await hubRefreshTokens('rt', 'user@york.ie');
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' });
  });

  it('returns transient on timeout error', async () => {
    hubHttpRequest.mockRejectedValue(new Error('Hub request timed out'));
    const result = await hubRefreshTokens('rt', 'user@york.ie');
    expect(result).toEqual({ ok: false, reason: 'transient' });
  });

  it('passes timeoutMs to hubHttpRequest', async () => {
    hubHttpRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        idToken: 'id',
        accessToken: 'access',
      }),
    });
    await hubRefreshTokens('rt', 'user@york.ie');
    expect(hubHttpRequest).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/refresh'),
      expect.objectContaining({
        method: 'POST',
        timeoutMs: 12_000,
      })
    );
  });
});
