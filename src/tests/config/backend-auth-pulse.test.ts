import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/auth/session', () => ({
  ensureAuthenticatedSession: vi.fn(),
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
}));

import { ensureAuthenticatedSession } from '../../main/auth/session';
import { getCognitoAuthHeaders, getPulseCognitoAuthHeaders } from '../../main/config/backend-auth';

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('backend-auth Cognito bearer selection', () => {
  beforeEach(() => {
    vi.mocked(ensureAuthenticatedSession).mockReset();
  });

  it('LaunchPad prefers Cognito id token (email claim)', async () => {
    const idToken = fakeJwt({ token_use: 'id', email: 'a@york.ie' });
    const accessToken = fakeJwt({ token_use: 'access', client_id: 'abc' });
    vi.mocked(ensureAuthenticatedSession).mockResolvedValue({
      idToken,
      accessToken,
      refreshToken: 'r',
      user: { id: '1', email: 'a@york.ie' },
    } as never);

    const headers = await getCognitoAuthHeaders();
    expect(headers.Authorization).toBe(`Bearer ${idToken}`);
  });

  it('R&D Pulse prefers Hub Cognito access token', async () => {
    const idToken = fakeJwt({ token_use: 'id', email: 'a@york.ie' });
    const accessToken = fakeJwt({ token_use: 'access', client_id: 'abc' });
    vi.mocked(ensureAuthenticatedSession).mockResolvedValue({
      idToken,
      accessToken,
      refreshToken: 'r',
      user: { id: '1', email: 'a@york.ie' },
    } as never);

    const headers = await getPulseCognitoAuthHeaders();
    expect(headers.Authorization).toBe(`Bearer ${accessToken}`);
  });
});
