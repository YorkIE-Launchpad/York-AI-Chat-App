import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructed: string[] = [];
const resolveKey = vi.fn();
const systemOne = vi.fn();
const noteAuthenticationRejected = vi.fn(async () => undefined);

vi.mock('@typesafe-ai/sdk', () => ({
  TypeSafeClient: class {
    constructor(opts: { apiKey: string }) {
      constructed.push(opts.apiKey);
    }
    systemOne(...args: unknown[]) {
      return systemOne(...args);
    }
  },
  choice: (instructions: string, criteria: unknown) => ({
    type: 'choice',
    instructions,
    criteria,
  }),
  noul: (instructions: string) => ({ type: 'noul', instructions }),
  score: (instructions: string, criteria: unknown) => ({
    type: 'score',
    instructions,
    criteria,
  }),
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: { getAll: () => ({ jevEnabled: true }) },
}));

vi.mock('../../main/auth/session', () => ({
  isAuthenticated: () => true,
  noteAuthenticationRejected,
}));

vi.mock('../../main/config/backend-auth', () => ({
  resolveBackendClientApiKey: (...args: unknown[]) => resolveKey(...args),
  getClientAppVersion: () => 'test',
}));

const header = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';
const tokenA = `${header}.payloadA.sigA`;
const tokenB = `${header}.payloadB.sigB`;

describe('jev client token cache', () => {
  beforeEach(() => {
    vi.resetModules();
    constructed.length = 0;
    resolveKey.mockReset();
    systemOne.mockReset();
    noteAuthenticationRejected.mockClear();
    systemOne.mockResolvedValue({
      model: 'test-model',
      usage: { input_tokens: 1, output_tokens: 2 },
      answers: {},
    });
  });

  it('builds a new client when the Cognito token refreshes, even if the header matches', async () => {
    expect(tokenA.slice(0, 12)).toBe(tokenB.slice(0, 12));
    resolveKey.mockResolvedValueOnce(tokenA).mockResolvedValueOnce(tokenB);
    const { resetJevClient, runJevDecision, noul } = await import('../../main/jev/jev-client');
    resetJevClient();
    await runJevDecision('hello', { q: noul('greeting?') }, { label: 'cache-a' });
    await runJevDecision('hello', { q: noul('greeting?') }, { label: 'cache-b' });
    expect(constructed).toEqual([tokenA, tokenB]);
  });

  it('reuses the client while the same token is current', async () => {
    resolveKey.mockResolvedValue(tokenA);
    const { resetJevClient, runJevDecision, noul } = await import('../../main/jev/jev-client');
    resetJevClient();
    await runJevDecision('hello', { q: noul('greeting?') }, { label: 'reuse-a' });
    await runJevDecision('hello', { q: noul('greeting?') }, { label: 'reuse-b' });
    expect(constructed).toEqual([tokenA]);
  });

  it('refreshes the session and retries once after an expired-token rejection', async () => {
    resolveKey.mockResolvedValueOnce(tokenA).mockResolvedValueOnce(tokenB);
    systemOne
      .mockRejectedValueOnce(
        Object.assign(new Error('401 Authentication failed'), {
          meta: { body: { message: 'Token expired at 2026-10-21T11:45:12.000Z' } },
        })
      )
      .mockResolvedValueOnce({
        model: 'test-model',
        usage: { input_tokens: 3, output_tokens: 4 },
        answers: {},
      });
    const { resetJevClient, runJevDecision, noul } = await import('../../main/jev/jev-client');
    resetJevClient();
    const result = await runJevDecision('hello', { q: noul('greeting?') }, { label: 'retry' });
    expect(result?.model).toBe('test-model');
    expect(noteAuthenticationRejected).toHaveBeenCalledOnce();
    expect(constructed).toEqual([tokenA, tokenB]);
  });
});
