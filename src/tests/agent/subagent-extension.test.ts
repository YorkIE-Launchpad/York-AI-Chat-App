import { describe, expect, it } from 'vitest';
import { SubagentExtension } from '../../main/agent/subagent-extension';

describe('SubagentExtension', () => {
  it('registers spawn_subagent with free model default and inherit opt-out', async () => {
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
    expect(tool?.description).toContain('free OpenRouter');
    expect(tool?.description).toContain('model="inherit"');

    const props = (tool?.parameters as { properties?: Record<string, unknown> })?.properties;
    expect(props).toHaveProperty('model');
    expect(props).toHaveProperty('task');
  });
});
