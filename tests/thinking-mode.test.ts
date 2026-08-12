import { describe, expect, it } from 'vitest';

import { buildThinkingModePromptSection, resolveThinkingLevel } from '../src/shared/thinking-mode';

describe('thinking-mode', () => {
  it('maps enableThinking off to thinking level off', () => {
    expect(resolveThinkingLevel(false)).toBe('off');
  });

  it('maps enableThinking on to high effort for complex tasks', () => {
    expect(resolveThinkingLevel(true)).toBe('high');
  });

  it('injects decisive reasoning guidance only when thinking is on', () => {
    expect(buildThinkingModePromptSection(false)).toBe('');
    const section = buildThinkingModePromptSection(true);
    expect(section).toContain('<thinking_mode>');
    expect(section).toMatch(/Never invent|do not invent|Prefer connected tools|Never invent metrics/i);
    expect(section).toMatch(/Goal\s*→\s*Evidence\s*→\s*Decision\s*→\s*Next/i);
    expect(section).toMatch(/paginate|pagination/i);
    expect(section).toMatch(/that seems hard/i);
    expect(section).toMatch(/think_tool_example/i);
    expect(section).not.toMatch(/slower, more deliberate/i);
  });
});
