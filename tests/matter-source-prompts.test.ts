import { describe, expect, it } from 'vitest';
import {
  normalizeMatterRuntimeConfig,
  normalizeMatterSourcePrompts,
} from '../src/main/matter/matter-config';
import { buildMatterRankerSystemPrompt } from '../src/main/matter/matter-ranker';
import {
  DEFAULT_MATTER_SOURCE_PROMPTS,
  MATTER_SOURCE_PROMPT_MAX_CHARS,
} from '../src/shared/matter';

describe('normalizeMatterSourcePrompts', () => {
  it('fills missing keys with empty strings', () => {
    expect(normalizeMatterSourcePrompts(undefined)).toEqual(DEFAULT_MATTER_SOURCE_PROMPTS);
    expect(normalizeMatterSourcePrompts({})).toEqual(DEFAULT_MATTER_SOURCE_PROMPTS);
  });

  it('trims, caps length, and ignores unknown keys', () => {
    const long = 'x'.repeat(MATTER_SOURCE_PROMPT_MAX_CHARS + 50);
    const result = normalizeMatterSourcePrompts({
      slack: '  only DMs  ',
      fused: 'nope',
      jira: long,
    });
    expect(result.slack).toBe('only DMs');
    expect(result.hub).toBe('');
    expect(result.jira).toHaveLength(MATTER_SOURCE_PROMPT_MAX_CHARS);
    expect(result).not.toHaveProperty('fused');
  });
});

describe('normalizeMatterRuntimeConfig sourcePrompts', () => {
  it('always includes sourcePrompts even when omitted', () => {
    const runtime = normalizeMatterRuntimeConfig({ enabled: true });
    expect(runtime.sourcePrompts).toEqual(DEFAULT_MATTER_SOURCE_PROMPTS);
  });
});

describe('buildMatterRankerSystemPrompt', () => {
  it('returns the built-in prompt when overrides are empty', () => {
    const prompt = buildMatterRankerSystemPrompt(DEFAULT_MATTER_SOURCE_PROMPTS, ['slack']);
    expect(prompt).toContain('Matter Ranker');
    expect(prompt).not.toContain('Source overrides from the employee');
  });

  it('includes Slack override when Slack is in the pool and omits empty Hub', () => {
    const prompt = buildMatterRankerSystemPrompt(
      {
        ...DEFAULT_MATTER_SOURCE_PROMPTS,
        slack: 'Only keep DMs from my squad',
        hub: '',
      },
      ['slack', 'gmail']
    );
    expect(prompt).toContain('Source overrides from the employee');
    expect(prompt).toContain('Slack: Only keep DMs from my squad');
    expect(prompt).not.toContain('York Hub:');
  });

  it('omits Slack override when Slack is not in the pool', () => {
    const prompt = buildMatterRankerSystemPrompt(
      { ...DEFAULT_MATTER_SOURCE_PROMPTS, slack: 'Only DMs' },
      ['jira']
    );
    expect(prompt).not.toContain('Source overrides');
    expect(prompt).not.toContain('Only DMs');
  });
});
