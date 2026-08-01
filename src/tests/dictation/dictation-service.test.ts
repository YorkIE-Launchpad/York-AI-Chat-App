import { beforeEach, describe, expect, it, vi } from 'vitest';

const isAuthenticatedMock = vi.fn();
const ensureAuthenticatedSessionMock = vi.fn();
const resolveBackendClientApiKeyMock = vi.fn();
const getBackendProxyBaseUrlMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../main/auth/session', () => ({
  isAuthenticated: () => isAuthenticatedMock(),
  ensureAuthenticatedSession: () => ensureAuthenticatedSessionMock(),
}));

vi.mock('../../main/config/backend-auth', () => ({
  resolveBackendClientApiKey: (...args: unknown[]) => resolveBackendClientApiKeyMock(...args),
}));

vi.mock('../../shared/backend-config', () => ({
  BACKEND_PROXY_PLACEHOLDER_KEY: 'sk-york-ie-local-proxy',
  getBackendProxyBaseUrl: (...args: unknown[]) => getBackendProxyBaseUrlMock(...args),
}));

describe('createRealtimeTranslationSession', () => {
  beforeEach(() => {
    vi.resetModules();
    isAuthenticatedMock.mockReset();
    ensureAuthenticatedSessionMock.mockReset();
    resolveBackendClientApiKeyMock.mockReset();
    getBackendProxyBaseUrlMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);

    isAuthenticatedMock.mockReturnValue(true);
    ensureAuthenticatedSessionMock.mockResolvedValue({
      user: { id: 42, email: 'user@york.ie', name: 'User', role: 'manager' },
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    resolveBackendClientApiKeyMock.mockResolvedValue('cognito-jwt');
    getBackendProxyBaseUrlMock.mockReturnValue('http://127.0.0.1:3001/openai/v1');
  });

  it('throws when not signed in', async () => {
    isAuthenticatedMock.mockReturnValue(false);
    const { createRealtimeTranslationSession } =
      await import('../../main/dictation/dictation-service');
    await expect(createRealtimeTranslationSession()).rejects.toThrow(/Sign in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints a client secret via the York OpenAI proxy', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ value: 'ek_test_secret' }),
    });

    const { createRealtimeTranslationSession } =
      await import('../../main/dictation/dictation-service');
    const result = await createRealtimeTranslationSession({ targetLanguage: 'en' });

    expect(result).toEqual({ clientSecret: 'ek_test_secret' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/openai/v1/realtime/translations/client_secrets',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer cognito-jwt',
          'Content-Type': 'application/json',
        }),
      })
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toEqual({
      session: {
        model: 'gpt-realtime-translate',
        audio: { output: { language: 'en' } },
      },
    });
  });

  it('accepts nested client_secret.value responses', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ client_secret: { value: 'ek_nested' } }),
    });

    const { createRealtimeTranslationSession } =
      await import('../../main/dictation/dictation-service');
    const result = await createRealtimeTranslationSession();
    expect(result.clientSecret).toBe('ek_nested');
  });

  it('surfaces upstream mint errors', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'Invalid authentication' } }),
    });

    const { createRealtimeTranslationSession } =
      await import('../../main/dictation/dictation-service');
    await expect(createRealtimeTranslationSession()).rejects.toThrow(/Invalid authentication/);
  });
});

describe('composeLivePrompt', () => {
  it('appends live text after the frozen baseline', async () => {
    const { composeLivePrompt } = await import('../../renderer/hooks/useDictation');
    expect(composeLivePrompt('Hello', 'there')).toBe('Hello there');
    expect(composeLivePrompt('', 'Hello')).toBe('Hello');
    expect(composeLivePrompt('Hello ', '')).toBe('Hello ');
  });
});
