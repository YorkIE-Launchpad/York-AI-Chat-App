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
  getClientAppVersion: () => '3.3.6',
}));

vi.mock('../../shared/backend-config', () => ({
  BACKEND_PROXY_PLACEHOLDER_KEY: 'sk-york-ie-local-proxy',
  getBackendProxyBaseUrl: (...args: unknown[]) => getBackendProxyBaseUrlMock(...args),
}));

describe('createRealtimeTranscriptionSession', () => {
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
    const { createRealtimeTranscriptionSession } =
      await import('../../main/meetings/meeting-realtime-transcription-service');
    await expect(createRealtimeTranscriptionSession()).rejects.toThrow(/Sign in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints a client secret via the York OpenAI proxy', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ value: 'ek_test_secret' }),
    });

    const { createRealtimeTranscriptionSession } =
      await import('../../main/meetings/meeting-realtime-transcription-service');
    const result = await createRealtimeTranscriptionSession({ delay: 'low' });

    expect(result).toEqual({ clientSecret: 'ek_test_secret' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/openai/v1/realtime/client_secrets',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer cognito-jwt',
          'Content-Type': 'application/json',
        }),
      })
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body
    ) as {
      session: {
        type: string;
        audio: {
          input: {
            transcription: { model: string; delay: string };
            noise_reduction: { type: string };
            turn_detection: { type: string };
          };
        };
      };
    };
    expect(body.session.type).toBe('transcription');
    expect(body.session.audio.input.transcription.model).toBe('gpt-live-transcribe');
    expect(body.session.audio.input.transcription.delay).toBe('low');
    expect(body.session.audio.input.noise_reduction.type).toBe('far_field');
    expect(body.session.audio.input.turn_detection.type).toBe('server_vad');
  });
});
