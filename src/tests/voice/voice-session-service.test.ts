import { beforeEach, describe, expect, it, vi } from 'vitest';

const isAuthenticatedMock = vi.fn();
const ensureAuthenticatedSessionMock = vi.fn();
const resolveBackendClientApiKeyMock = vi.fn();
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
  getBackendProxyBaseUrl: () => 'http://127.0.0.1:3001/openai/v1',
}));

function okResponse(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

interface SentSession {
  type: string;
  model: string;
  instructions: string;
  audio: { input: { turn_detection: Record<string, unknown> } };
  tools: Array<{ name: string }>;
}

function sentBody(): { session: SentSession } {
  return JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
}

describe('createVoiceSession', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    isAuthenticatedMock.mockReset().mockReturnValue(true);
    ensureAuthenticatedSessionMock.mockReset().mockResolvedValue({ user: { id: 7 } });
    resolveBackendClientApiKeyMock.mockReset().mockResolvedValue('cognito-jwt');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('requires sign-in', async () => {
    isAuthenticatedMock.mockReturnValue(false);
    const { createVoiceSession } = await import('../../main/voice/voice-session-service');
    await expect(createVoiceSession()).rejects.toThrow(/Sign in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints a gpt-realtime-2.1-mini session with semantic VAD and the voice tools', async () => {
    fetchMock.mockResolvedValue(okResponse({ value: 'ek_voice' }));
    const { createVoiceSession } = await import('../../main/voice/voice-session-service');

    await expect(createVoiceSession()).resolves.toEqual({
      clientSecret: 'ek_voice',
      model: 'gpt-realtime-2.1-mini',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/openai/v1/realtime/client_secrets',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer cognito-jwt' }),
      })
    );

    const { session } = sentBody();
    expect(session.type).toBe('realtime');
    expect(session.model).toBe('gpt-realtime-2.1-mini');
    expect(session.audio.input.turn_detection).toMatchObject({
      type: 'semantic_vad',
      create_response: true,
    });
    expect(session.tools.map((tool) => tool.name)).toEqual([
      'do_on_screen',
      'look_at_screen',
      'web_search',
      'read_webpage',
      'open_url',
      'ask_growthos',
      'scroll',
      'switch_tab',
      'open_app',
      'focus_app',
      'press_keys',
      'type_text',
      'write',
      'set_model',
      'get_model',
      'stop_listening',
    ]);
    expect(session.instructions).toMatch(/control the user's Mac/);
  });

  it('honours the model override env var', async () => {
    vi.stubEnv('YORK_VOICE_REALTIME_MODEL', 'gpt-realtime-next');
    fetchMock.mockResolvedValue(okResponse({ client_secret: { value: 'ek_nested' } }));
    const { createVoiceSession } = await import('../../main/voice/voice-session-service');

    await expect(createVoiceSession()).resolves.toEqual({
      clientSecret: 'ek_nested',
      model: 'gpt-realtime-next',
    });
    expect(sentBody().session.model).toBe('gpt-realtime-next');
  });

  it('surfaces backend errors', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'Model not allowed' } }),
    });
    const { createVoiceSession } = await import('../../main/voice/voice-session-service');
    await expect(createVoiceSession()).rejects.toThrow('Model not allowed');
  });

  it('fails when the response has no client secret', async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const { createVoiceSession } = await import('../../main/voice/voice-session-service');
    await expect(createVoiceSession()).rejects.toThrow(/client secret/);
  });
});
