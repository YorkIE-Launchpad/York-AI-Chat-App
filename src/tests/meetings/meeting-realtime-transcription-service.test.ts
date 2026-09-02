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
            transcription: {
              model: string;
              delay: string;
              prompt?: string;
              languages?: string[];
            };
            noise_reduction: { type: string };
            turn_detection: null;
          };
        };
      };
    };
    expect(body.session.type).toBe('transcription');
    expect(body.session.audio.input.transcription.model).toBe('gpt-live-transcribe');
    expect(body.session.audio.input.transcription.delay).toBe('low');
    expect(body.session.audio.input.transcription.prompt).toContain('York IE meeting');
    expect(body.session.audio.input.transcription.languages).toEqual(['en']);
    expect(body.session.audio.input.noise_reduction.type).toBe('far_field');
    // gpt-live-transcribe rejects server_vad / semantic_vad.
    expect(body.session.audio.input.turn_detection).toBeNull();
  });

  it('falls back without prompt when primary model mint fails', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: { message: 'Turn detection is not supported for this transcription model.' },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ value: 'ek_fallback_secret' }),
      });

    const { createRealtimeTranscriptionSession } =
      await import('../../main/meetings/meeting-realtime-transcription-service');
    const result = await createRealtimeTranscriptionSession({ delay: 'low' });

    expect(result).toEqual({ clientSecret: 'ek_fallback_secret' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const fallbackBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as { body: string }).body
    ) as {
      session: {
        audio: {
          input: {
            transcription: Record<string, unknown>;
            turn_detection: null;
          };
        };
      };
    };
    expect(fallbackBody.session.audio.input.transcription).toEqual({
      model: 'gpt-realtime-whisper',
    });
    expect(fallbackBody.session.audio.input.turn_detection).toBeNull();
  });
});
