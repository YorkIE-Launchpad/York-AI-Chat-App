import { describe, expect, it } from 'vitest';
import { SubagentExtension } from '../../main/agent/subagent-extension';

describe('SubagentExtension', () => {
  it('registers spawn_subagent with inherit model default and free opt-in', async () => {
    const extension = new SubagentExtension(
      () => null,
      () => undefined,
      null,
      () => null
    );
    const result = await extension.beforeSessionRun({
      session: { id: 's1' },
      prompt: 'hi',
      existingMessages: [],
      isColdStart: true,
    } as never);

    const tool = result.customTools?.[0];
    expect(tool?.name).toBe('spawn_subagent');
    expect(tool?.description).toContain('Prefer completing');
    expect(tool?.description).toContain('parent quality model');
    expect(tool?.description).toContain('model="free"');

    const props = (tool?.parameters as { properties?: Record<string, unknown> })?.properties;
    expect(props).toHaveProperty('model');
    expect(props).toHaveProperty('task');
  });
});
