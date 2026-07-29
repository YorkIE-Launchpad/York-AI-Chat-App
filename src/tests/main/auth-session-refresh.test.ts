import { beforeEach, describe, expect, it, vi } from 'vitest';

const hubRefreshTokens = vi.fn();
const authStore = {
  save: vi.fn(),
  clear: vi.fn(),
  load: vi.fn().mockReturnValue(null),
};

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../main/auth/hub-oauth', () => ({
  hubRefreshTokens: (...args: unknown[]) => hubRefreshTokens(...args),
  hubLogoutRequest: vi.fn(),
  runHubGoogleOAuthFlow: vi.fn(),
  exchangeHubAuthCode: vi.fn(),
  initHubOAuthRelay: vi.fn(),
}));

vi.mock('../../main/auth/auth-store', () => ({
  authStore,
}));

vi.mock('../../main/auth/cognito', () => ({
  verifyCognitoToken: vi.fn().mockResolvedValue({ sub: 'u1', email: 'user@york.ie' }),
  verifyCognitoTokenDetailed: vi.fn().mockResolvedValue({
    ok: true,
    payload: { sub: 'u1', email: 'user@york.ie' },
  }),
}));

vi.mock('../../main/auth/user-service', () => ({
  findOrCreateUserFromCognitoPayload: vi.fn().mockReturnValue({
    user: {
      id: 1,
      email: 'user@york.ie',
      name: 'User',
      role: 'manager',
      image: null,
    },
  }),
  findUserById: vi.fn().mockReturnValue({
    id: 1,
    email: 'user@york.ie',
    name: 'User',
    role: 'manager',
    image: null,
  }),
  updateUserImage: vi.fn(),
}));

vi.mock('../../main/auth/hub-profile-image', () => ({
  fetchHubProfileImage: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../main/auth/hub-parse', () => ({
  getHubProfileEmail: vi.fn().mockReturnValue(null),
  getHubProfileImage: vi.fn().mockReturnValue(null),
  getHubProfileName: vi.fn().mockReturnValue(null),
  normalizeProfileImageUrl: (url: string) => url,
}));

function makeJwt(expSecFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecFromNow, sub: 'u1' })
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('tryRefreshSession', () => {
  beforeEach(async () => {
    vi.resetModules();
    hubRefreshTokens.mockReset();
    authStore.save.mockReset();
    authStore.clear.mockReset();
    authStore.load.mockReturnValue(null);
  });

  async function loadSession() {
    return import('../../main/auth/session');
  }

  it('dedupes concurrent refresh calls into one Hub request', async () => {
    const sessionMod = await loadSession();
    sessionMod.__resetAuthSessionForTests();
    const idToken = makeJwt(120);
    sessionMod.__setAuthSessionForTests({
      user: {
        id: 1,
        email: 'user@york.ie',
        name: 'User',
        role: 'manager',
        image: null,
      },
      idToken,
      accessToken: idToken,
      refreshToken: 'rt-1',
    });

    let resolveRefresh: (value: unknown) => void = () => undefined;
    hubRefreshTokens.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const p1 = sessionMod.tryRefreshSession();
    const p2 = sessionMod.tryRefreshSession();
    expect(hubRefreshTokens).toHaveBeenCalledTimes(1);

    resolveRefresh({
      ok: true,
      tokens: {
        idToken: makeJwt(3600),
        accessToken: makeJwt(3600),
        refreshToken: 'rt-2',
      },
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(hubRefreshTokens).toHaveBeenCalledTimes(1);
  });

  it('keeps session on transient Hub failure', async () => {
    const sessionMod = await loadSession();
    sessionMod.__resetAuthSessionForTests();
    const idToken = makeJwt(120);
    sessionMod.__setAuthSessionForTests({
      user: {
        id: 1,
        email: 'user@york.ie',
        name: 'User',
        role: 'manager',
        image: null,
      },
      idToken,
      accessToken: idToken,
      refreshToken: 'rt-1',
    });

    hubRefreshTokens.mockResolvedValue({ ok: false, reason: 'transient' });

    const result = await sessionMod.tryRefreshSession();
    expect(result).toEqual({ ok: false, reason: 'transient' });
    expect(authStore.clear).not.toHaveBeenCalled();
    expect(sessionMod.getCurrentSession()?.refreshToken).toBe('rt-1');

    await expect(sessionMod.refreshAuth(null)).resolves.toMatchObject({
      user: expect.objectContaining({ email: 'user@york.ie' }),
    });
    expect(authStore.clear).not.toHaveBeenCalled();
  });

  it('wipes session on invalid_grant', async () => {
    const sessionMod = await loadSession();
    sessionMod.__resetAuthSessionForTests();
    const idToken = makeJwt(120);
    sessionMod.__setAuthSessionForTests({
      user: {
        id: 1,
        email: 'user@york.ie',
        name: 'User',
        role: 'manager',
        image: null,
      },
      idToken,
      accessToken: idToken,
      refreshToken: 'rt-1',
    });

    hubRefreshTokens.mockResolvedValue({ ok: false, reason: 'invalid_grant' });

    const result = await sessionMod.tryRefreshSession();
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' });

    await expect(sessionMod.refreshAuth(null)).rejects.toMatchObject({
      name: 'AuthRequiredError',
    });
    expect(authStore.clear).toHaveBeenCalled();
    expect(sessionMod.getCurrentSession()).toBeNull();
  });
});

describe('ensureAuthenticatedSession', () => {
  beforeEach(async () => {
    vi.resetModules();
    hubRefreshTokens.mockReset();
    authStore.save.mockReset();
    authStore.clear.mockReset();
    authStore.load.mockReturnValue(null);
  });

  async function loadSession() {
    return import('../../main/auth/session');
  }

  it('keeps usable session when proactive refresh gets invalid_grant', async () => {
    const sessionMod = await loadSession();
    sessionMod.__resetAuthSessionForTests();
    // ~4 minutes left → expiring soon (5m buffer) but not expired (60s buffer)
    const idToken = makeJwt(240);
    sessionMod.__setAuthSessionForTests({
      user: {
        id: 1,
        email: 'user@york.ie',
        name: 'User',
        role: 'manager',
        image: null,
      },
      idToken,
      accessToken: idToken,
      refreshToken: 'rt-1',
    });

    hubRefreshTokens.mockResolvedValue({ ok: false, reason: 'invalid_grant' });

    const ensured = await sessionMod.ensureAuthenticatedSession();
    expect(ensured.refreshToken).toBe('rt-1');
    expect(authStore.clear).not.toHaveBeenCalled();
    expect(sessionMod.getCurrentSession()?.refreshToken).toBe('rt-1');
  });

  it('wipes and throws when token is expired and refresh is invalid_grant', async () => {
    const sessionMod = await loadSession();
    sessionMod.__resetAuthSessionForTests();
    const idToken = makeJwt(-120);
    sessionMod.__setAuthSessionForTests({
      user: {
        id: 1,
        email: 'user@york.ie',
        name: 'User',
        role: 'manager',
        image: null,
      },
      idToken,
      accessToken: idToken,
      refreshToken: 'rt-1',
    });

    hubRefreshTokens.mockResolvedValue({ ok: false, reason: 'invalid_grant' });

    await expect(sessionMod.ensureAuthenticatedSession()).rejects.toMatchObject({
      name: 'AuthRequiredError',
    });
    expect(authStore.clear).toHaveBeenCalled();
    expect(sessionMod.getCurrentSession()).toBeNull();
  });
});
