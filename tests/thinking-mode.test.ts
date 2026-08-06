import { describe, expect, it } from 'vitest';

import { buildThinkingModePromptSection, resolveThinkingLevel } from '../src/shared/thinking-mode';

describe('thinking-mode', () => {
  it('maps enableThinking off to thinking level off', () => {
    expect(resolveThinkingLevel(false)).toBe('off');
  });

  it('maps enableThinking on to high effort for complex tasks', () => {
    expect(resolveThinkingLevel(true)).toBe('high');
  });

  it('injects careful-reasoning guidance only when thinking is on', () => {
    expect(buildThinkingModePromptSection(false)).toBe('');
    const section = buildThinkingModePromptSection(true);
    expect(section).toContain('<thinking_mode>');
    expect(section).toMatch(/Never invent|do not invent|Prefer connected tools/i);
  });
});
