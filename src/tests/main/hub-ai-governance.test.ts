import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHubUsagePayloadFromPiUsage,
  clearHubGovernanceModelsCache,
  extractVisionApiUsage,
  fetchHubGovernanceModelsForToken,
  HubAiGovernanceError,
  joinCatalogWithAllowedModels,
  parseHubGovernanceModels,
  parseUserAllowedAiModels,
  postHubGovernanceUsage,
  postHubGovernanceUsageForToken,
  reportMcpVisionUsageViaEnv,
} from '../../main/hub/hub-ai-governance';

vi.mock('../../shared/auth-config', () => ({
  authConfig: {
    hubApiUrl: 'https://api.hub.test',
  },
}));

vi.mock('../../main/auth/session', () => ({
  ensureAuthenticatedSession: vi.fn(async () => ({
    accessToken: 'access-token',
    idToken: 'id-token',
    user: { email: 'jane@york.ie' },
  })),
}));

describe('parseHubGovernanceModels', () => {
  it('unwraps Hub success envelope from apidoc sample', () => {
    const models = parseHubGovernanceModels({
      success: true,
      data: {
        models: [
          {
            id: 'gpt-4o',
            name: 'GPT-4o',
            provider: 'openai',
            is_default_active: true,
            is_free: false,
          },
          {
            id: 'claude-sonnet-4',
            name: 'Claude Sonnet 4',
            provider: 'anthropic',
            is_default_active: false,
            is_free: true,
          },
        ],
      },
      statusCode: 200,
      timestamp: '2026-08-12T12:00:00.000Z',
    });

    expect(models).toEqual([
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'openai',
        isFree: false,
        isDefaultActive: true,
      },
      {
        id: 'claude-sonnet-4',
        name: 'Claude Sonnet 4',
        provider: 'anthropic',
        isFree: true,
        isDefaultActive: false,
      },
    ]);
  });

  it('accepts bare { models } without envelope', () => {
    expect(
      parseHubGovernanceModels({
        models: [{ id: 'o4-mini', name: 'o4 Mini', provider: 'openai' }],
      })
    ).toEqual([{ id: 'o4-mini', name: 'o4 Mini', provider: 'openai' }]);
  });

  it('skips unsupported providers and dedupes', () => {
    const models = parseHubGovernanceModels({
      success: true,
      data: {
        models: [
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
          { id: 'mystery', name: 'Mystery', provider: 'azure' },
          { id: 'gpt-4o', name: 'GPT-4o Dup', provider: 'openai' },
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini' },
          { id: 'openrouter/auto', name: 'OpenRouter Auto', provider: 'openrouter' },
        ],
      },
    });

    expect(models).toEqual([
      { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini' },
      { id: 'openrouter/auto', name: 'OpenRouter Auto', provider: 'openrouter' },
    ]);
  });

  it('falls back name to id and accepts model_id', () => {
    expect(
      parseHubGovernanceModels({
        data: {
          models: [{ model_id: 'claude-haiku-4-5', provider: 'anthropic' }],
        },
      })
    ).toEqual([{ id: 'claude-haiku-4-5', name: 'claude-haiku-4-5', provider: 'anthropic' }]);
  });

  it('returns empty for missing models', () => {
    expect(parseHubGovernanceModels({ success: true, data: {} })).toEqual([]);
    expect(parseHubGovernanceModels(null)).toEqual([]);
  });
});

describe('parseUserAllowedAiModels', () => {
  it('parses apidoc allowed-models envelope with has_budget', () => {
    const parsed = parseUserAllowedAiModels({
      success: true,
      data: {
        email: 'jane@york.ie',
        has_budget: true,
        grants: [
          {
            model_id: 'gpt-4o',
            workspace_tags: [],
            source: 'default',
            is_free: false,
            has_budget: true,
          },
          {
            model_id: 'claude-sonnet-4',
            workspace_tags: ['cursor', 'hub'],
            source: 'user',
            is_free: true,
            has_budget: true,
          },
        ],
        model_ids: ['gpt-4o', 'claude-sonnet-4'],
      },
    });

    expect(parsed).toEqual({
      email: 'jane@york.ie',
      hasBudget: true,
      modelIds: ['gpt-4o', 'claude-sonnet-4'],
      grants: [
        {
          modelId: 'gpt-4o',
          workspaceTags: [],
          source: 'default',
          isFree: false,
          hasBudget: true,
        },
        {
          modelId: 'claude-sonnet-4',
          workspaceTags: ['cursor', 'hub'],
          source: 'user',
          isFree: true,
          hasBudget: true,
        },
      ],
    });
  });

  it('falls back modelIds from grants when model_ids missing', () => {
    const parsed = parseUserAllowedAiModels({
      data: {
        email: 'a@york.ie',
        has_budget: false,
        grants: [{ model_id: 'claude-sonnet-4', is_free: true, has_budget: true }],
      },
    });
    expect(parsed.hasBudget).toBe(false);
    expect(parsed.modelIds).toEqual(['claude-sonnet-4']);
  });
});

describe('joinCatalogWithAllowedModels', () => {
  const catalog = [
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      provider: 'openai' as const,
      isFree: false,
      isDefaultActive: true,
    },
    {
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      provider: 'anthropic' as const,
      isFree: true,
    },
    {
      id: 'o4-mini',
      name: 'o4 Mini',
      provider: 'openai' as const,
    },
  ];

  it('returns catalog unchanged when allowed is null', () => {
    expect(joinCatalogWithAllowedModels(catalog, null)).toEqual(catalog);
  });

  it('intersects and applies grant is_free / has_budget', () => {
    const joined = joinCatalogWithAllowedModels(catalog, {
      email: 'jane@york.ie',
      hasBudget: false,
      modelIds: ['gpt-4o', 'claude-sonnet-4'],
      grants: [
        { modelId: 'gpt-4o', workspaceTags: [], isFree: false, hasBudget: false },
        { modelId: 'claude-sonnet-4', workspaceTags: [], isFree: true, hasBudget: true },
      ],
    });

    expect(joined).toEqual([
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'openai',
        isFree: false,
        isDefaultActive: true,
        hasBudget: false,
      },
      {
        id: 'claude-sonnet-4',
        name: 'Claude Sonnet 4',
        provider: 'anthropic',
        isFree: true,
        hasBudget: true,
      },
    ]);
  });
});

describe('fetchHubGovernanceModelsForToken', () => {
  afterEach(() => {
    clearHubGovernanceModelsCache();
  });

  it('fetches and parses models via Hub GET', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          models: [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }],
        },
      }),
    })) as unknown as typeof fetch;

    const models = await fetchHubGovernanceModelsForToken({
      token: 'access-token',
      fetchFn,
    });

    expect(models).toEqual([{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }]);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.hub.test/api/ai-governance/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
        }),
      })
    );
  });

  it('retries with alternate token on 403', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ success: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' }],
          },
        }),
      }) as unknown as typeof fetch;

    const models = await fetchHubGovernanceModelsForToken({
      token: 'access-token',
      alternateToken: 'id-token',
      fetchFn,
    });

    expect(models).toEqual([
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws HubAiGovernanceError on failure', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ success: false }),
    })) as unknown as typeof fetch;

    await expect(
      fetchHubGovernanceModelsForToken({ token: 'access-token', fetchFn })
    ).rejects.toMatchObject({
      name: 'HubAiGovernanceError',
      status: 403,
    } satisfies Partial<HubAiGovernanceError>);
  });
});

describe('buildHubUsagePayloadFromPiUsage', () => {
  it('maps tokens, cost, session, and project from pi-ai usage', () => {
    const payload = buildHubUsagePayloadFromPiUsage({
      modelId: 'claude-sonnet-4',
      provider: 'anthropic',
      sessionId: 'sess_xyz',
      hubProjectId: 'f6a7b8c9-d0e1-2345-f012-456789012345',
      folderId: 'folder-1',
      launchpadProjectId: 42,
      division: 'project',
      responseId: 'req_abc123',
      latencyMs: 1850.4,
      occurredAt: new Date('2026-08-12T11:30:00.000Z'),
      usage: {
        input: 1200,
        output: 400,
        cacheRead: 150,
        cacheWrite: 50,
        totalTokens: 1600,
        cost: {
          input: 0.03,
          output: 0.0125,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.0425,
        },
      },
    });

    expect(payload).toEqual({
      model_id: 'claude-sonnet-4',
      provider: 'anthropic',
      source: 'vecos',
      feature: 'chat',
      session_id: 'sess_xyz',
      project_id: 'f6a7b8c9-d0e1-2345-f012-456789012345',
      request_id: 'req_abc123',
      occurred_at: '2026-08-12T11:30:00.000Z',
      prompt_tokens: 1200,
      completion_tokens: 400,
      total_tokens: 1600,
      cached_tokens: 200,
      cost: 0.0425,
      currency: 'USD',
      input_cost: 0.03,
      output_cost: 0.0125,
      latency_ms: 1850,
      status: 'ok',
      metadata: {
        workspace: 'project',
        folder_id: 'folder-1',
        launchpad_project_id: 42,
      },
    });
  });

  it('returns null when no tokens or cost', () => {
    expect(
      buildHubUsagePayloadFromPiUsage({
        modelId: 'gpt-4o',
        provider: 'openai',
        sessionId: 's1',
        usage: {},
      })
    ).toBeNull();
  });

  it('accepts input_tokens/output_tokens aliases and sums total', () => {
    const payload = buildHubUsagePayloadFromPiUsage({
      modelId: 'gpt-4o',
      provider: 'openai',
      sessionId: 's1',
      division: 'general',
      usage: { input_tokens: 10, output_tokens: 5 },
      occurredAt: new Date('2026-08-12T00:00:00.000Z'),
    });
    expect(payload).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      metadata: { workspace: 'general' },
    });
  });

  it('honors feature override and merges extra metadata', () => {
    const payload = buildHubUsagePayloadFromPiUsage({
      modelId: 'gpt-5.6-luna',
      provider: 'openai',
      sessionId: 'matter_scan',
      feature: 'matter_scan',
      metadata: { subagent_id: 'child-1' },
      usage: { input: 3, output: 1 },
      occurredAt: new Date('2026-08-12T00:00:00.000Z'),
    });
    expect(payload).toMatchObject({
      feature: 'matter_scan',
      metadata: { subagent_id: 'child-1' },
    });
  });
});

describe('extractVisionApiUsage', () => {
  it('maps OpenAI and Anthropic usage shapes', () => {
    expect(
      extractVisionApiUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      })
    ).toEqual({ input: 100, output: 20, totalTokens: 120 });

    expect(extractVisionApiUsage({ input_tokens: 50, output_tokens: 10 })).toEqual({
      input: 50,
      output: 10,
      totalTokens: 60,
    });
  });

  it('returns null when empty', () => {
    expect(extractVisionApiUsage({})).toBeNull();
    expect(extractVisionApiUsage(null)).toBeNull();
  });
});

describe('reportMcpVisionUsageViaEnv', () => {
  it('POSTs mcp_vision usage when token and hub url are provided', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    })) as unknown as typeof fetch;

    reportMcpVisionUsageViaEnv({
      modelId: 'claude-sonnet-4-6',
      provider: 'anthropic',
      usage: { input_tokens: 40, output_tokens: 8 },
      functionName: 'planGUIActions',
      latencyMs: 900,
      hubApiUrl: 'https://api.hub.test',
      accessToken: 'vision-token',
      fetchFn,
    });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.hub.test/api/ai-governance/usage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer vision-token',
        }),
      })
    );
    const body = JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({
      feature: 'mcp_vision',
      model_id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      prompt_tokens: 40,
      completion_tokens: 8,
      metadata: { vision_function: 'planGUIActions' },
    });
  });
});

describe('postHubGovernanceUsage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs usage with Bearer token and body', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { id: 'usage-1', user_budget_status: 'ok' },
      }),
    })) as unknown as typeof fetch;

    const payload = buildHubUsagePayloadFromPiUsage({
      modelId: 'gpt-4o',
      provider: 'openai',
      sessionId: 'sess_1',
      usage: { input: 1, output: 2 },
      occurredAt: new Date('2026-08-12T12:00:00.000Z'),
    })!;

    const data = await postHubGovernanceUsageForToken({
      token: 'access-token',
      payload,
      fetchFn,
    });

    expect(data).toEqual({ id: 'usage-1', user_budget_status: 'ok' });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.hub.test/api/ai-governance/usage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(payload),
      })
    );
  });

  it('public wrapper swallows non-OK responses', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false }),
    })) as unknown as typeof fetch;

    const payload = buildHubUsagePayloadFromPiUsage({
      modelId: 'gpt-4o',
      provider: 'openai',
      sessionId: 'sess_1',
      usage: { input: 1, output: 2 },
      occurredAt: new Date('2026-08-12T12:00:00.000Z'),
    })!;

    await expect(postHubGovernanceUsage(payload, { fetchFn })).resolves.toBeUndefined();
  });
});
