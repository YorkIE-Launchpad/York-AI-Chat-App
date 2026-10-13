import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetAll, mockRunChildAgentSession } = vi.hoisted(() => ({
  mockGetAll: vi.fn(),
  mockRunChildAgentSession: vi.fn(),
}));
vi.mock('../../main/config/config-store', () => ({
  configStore: { getAll: mockGetAll, get: vi.fn() },
}));
vi.mock('../../main/agent/child-agent-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../main/agent/child-agent-session')>()),
  runChildAgentSession: mockRunChildAgentSession,
}));

import { SubagentExtension } from '../../main/agent/subagent-extension';
import { DEFAULT_SUBAGENT_CONFIG } from '../../shared/subagent-config';
import * as logger from '../../main/utils/logger';

type ToolExecuteFn = (toolCallId: string, params: unknown) => Promise<unknown>;

const context = {
  session: { id: 's1', cwd: '/tmp' },
  prompt: 'hi',
  existingMessages: [],
  isColdStart: true,
};

async function getTool(overrides: Record<string, unknown> = {}) {
  const extension = new SubagentExtension(
    () => null,
    () => undefined,
    null,
    () => null
  );
  const result = await extension.beforeSessionRun({ ...context, ...overrides } as never);
  return result.customTools![0];
}

describe('SubagentExtension', () => {
  beforeEach(() => {
    mockGetAll.mockReturnValue({ provider: 'openrouter', model: 'parent-model' });
    mockRunChildAgentSession.mockReset().mockResolvedValue({
      text: 'child result',
      subagentId: 'child-1',
      durationMs: 1,
    });
  });

  it('registers spawn_subagent with inherit model default and free opt-in', async () => {
    const tool = await getTool();
    expect(tool?.name).toBe('spawn_subagent');
    expect(tool?.description).toContain('Prefer completing');
    expect(tool?.description).toContain('parent quality model');
    expect(tool?.description).toContain('model="free"');

    const props = (tool?.parameters as { properties?: Record<string, unknown> })?.properties;
    expect(props).toHaveProperty('model');
    expect(props).toHaveProperty('task');
    expect(props).toHaveProperty('agent');
  });

  it('refuses host-tool child execution in an isolated sandbox', async () => {
    const tool = await getTool({ sandboxIsolated: true });
    const output = await (tool.execute as unknown as ToolExecuteFn)('child', { task: 'write' });
    expect(JSON.stringify(output)).toContain('sandbox');
    expect(mockRunChildAgentSession).not.toHaveBeenCalled();
  });

  it('keeps parent sessions usable when child configuration is invalid', async () => {
    const configError = 'Unknown default subagent: private-role-name';
    const logError = vi.spyOn(logger, 'logError').mockImplementation(() => {});
    mockGetAll.mockReturnValue({ ...mockGetAll(), subagentConfigError: configError });
    const tool = await getTool();
    const output = await (tool.execute as unknown as ToolExecuteFn)('child', { task: 'inspect' });
    expect(JSON.stringify(output)).toContain('Repair it in Settings > Subagents.');
    expect(logError).toHaveBeenCalledWith(
      '[SubagentExtension] Invalid subagent configuration:',
      configError
    );
    expect(mockRunChildAgentSession).not.toHaveBeenCalled();
  });

  it('rejects an unknown role preset', async () => {
    const tool = await getTool();
    const output = await (tool.execute as unknown as ToolExecuteFn)('child', {
      task: 'inspect',
      agent: 'nope',
    });
    expect(JSON.stringify(output)).toContain('unknown subagent preset: nope');
    expect(mockRunChildAgentSession).not.toHaveBeenCalled();
  });

  it('applies the role preset prompt, model, tools, and concurrency limit', async () => {
    mockGetAll.mockReturnValue({
      ...mockGetAll(),
      subagent: {
        ...DEFAULT_SUBAGENT_CONFIG,
        maxConcurrent: 5,
        presets: DEFAULT_SUBAGENT_CONFIG.presets.map((preset) =>
          preset.name === 'reviewer' ? { ...preset, model: 'review-model' } : preset
        ),
      },
    });
    const tool = await getTool();
    const output = await (tool.execute as unknown as ToolExecuteFn)('child', {
      task: 'review',
      agent: 'reviewer',
    });

    expect(JSON.stringify(output)).toContain('child result');
    const input = mockRunChildAgentSession.mock.calls[0][0];
    expect(input).toMatchObject({
      modelMode: 'inherit',
      modelOverride: 'review-model',
      maxConcurrent: 5,
      includeReadOnlyTools: true,
    });
    expect(input.rolePrompt).toContain('Review the requested code');
    expect(input.toolFilter('read')).toBe(true);
    expect(input.toolFilter('write')).toBe(false);
  });

  it('keeps the York free-model route and parent tools without a preset', async () => {
    const tool = await getTool();
    await (tool.execute as unknown as ToolExecuteFn)('child', { task: 'bulk', model: 'free' });
    const input = mockRunChildAgentSession.mock.calls[0][0];
    expect(input.modelMode).toBe('free');
    expect(input.toolFilter).toBeUndefined();
    expect(input.rolePrompt).toBeUndefined();
  });
});
