import { describe, expect, it } from 'vitest';
import {
  pickAutoModel,
  scorePromptComplexity,
  tierForScore,
  AUTO_MODEL_ID,
  isAutoModelId,
} from '../../shared/auto-model';
import type { BackendModelInfo } from '../../shared/backend-config';

const catalog: BackendModelInfo[] = [
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'anthropic' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai' },
  { id: 'gpt-5.6', name: 'GPT-5.6', provider: 'openai' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'gemini' },
];

describe('auto-model', () => {
  it('recognizes the auto model id', () => {
    expect(isAutoModelId(AUTO_MODEL_ID)).toBe(true);
    expect(isAutoModelId(' Auto ')).toBe(true);
    expect(isAutoModelId('claude-sonnet-5')).toBe(false);
  });

  it('scores short prompts as low complexity', () => {
    expect(scorePromptComplexity('hi')).toBeLessThan(35);
  });

  it('scores code-heavy prompts higher', () => {
    const prompt = [
      'Please refactor this TypeScript module and fix the failing unit test.',
      '```ts',
      'export function broken() { throw new Error("boom"); }',
      '```',
      'See src/main/agent/agent-runner.ts',
    ].join('\n');
    expect(scorePromptComplexity(prompt)).toBeGreaterThanOrEqual(35);
  });

  it('scores architecture/reasoning prompts into frontier range', () => {
    const prompt =
      'Analyze the architecture trade-offs and design a multi-step migration plan ' +
      'comparing options. Prove which approach is better for our scale. ' +
      'Evaluate the strategy carefully.';
    const score = scorePromptComplexity(prompt, { messageCount: 40, contextChars: 220_000 });
    expect(score).toBeGreaterThanOrEqual(70);
    expect(tierForScore(score, 'balanced')).toBe('frontier');
  });

  it('eco preference shifts tier down', () => {
    expect(tierForScore(80, 'eco')).toBe('balanced');
    expect(tierForScore(50, 'eco')).toBe('fast');
  });

  it('max preference shifts tier up', () => {
    expect(tierForScore(10, 'max')).toBe('balanced');
    expect(tierForScore(50, 'max')).toBe('frontier');
  });

  it('picks a fast-tier model for simple prompts', () => {
    const score = scorePromptComplexity('thanks');
    const pick = pickAutoModel(catalog, score, 'balanced');
    expect(pick.tier).toBe('fast');
    expect(pick.modelId).toBe('claude-haiku-4-5');
    expect(pick.provider).toBe('anthropic');
  });

  it('picks frontier for hard prompts with max preference', () => {
    const score = scorePromptComplexity(
      'Analyze the architecture and design a multi-step plan comparing trade-offs.',
      { messageCount: 20, contextChars: 60_000 }
    );
    const pick = pickAutoModel(catalog, score, 'max');
    expect(pick.tier).toBe('frontier');
    expect(pick.modelId).toBe('claude-fable-5');
  });

  it('falls back through the chain when preferred tier is unavailable', () => {
    const openaiOnly = catalog.filter((m) => m.provider === 'openai');
    const pick = pickAutoModel(openaiOnly, 10, 'balanced');
    expect(pick.provider).toBe('openai');
    expect(pick.modelId).toBe('gpt-5.4-mini');
  });

  it('uses ultimate fallback when catalog is empty', () => {
    const pick = pickAutoModel([], 50, 'balanced');
    expect(pick.provider).toBe('anthropic');
    expect(pick.modelId).toBe('claude-sonnet-5');
    expect(pick.reason).toContain('ultimate-fallback');
  });

  it('prefers OpenRouter free models for eco/fast when only free catalog is available', () => {
    const freeOnly: BackendModelInfo[] = [
      { id: 'openrouter/free', name: 'OpenRouter Free', provider: 'openrouter' },
      {
        id: 'meta-llama/llama-3.2-3b-instruct:free',
        name: 'Llama 3.2 3B (Free)',
        provider: 'openrouter',
      },
      {
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        name: 'Llama 3.3 70B (Free)',
        provider: 'openrouter',
      },
      {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'Nemotron 3 Super (Free)',
        provider: 'openrouter',
      },
    ];
    const score = scorePromptComplexity('hi');
    const pick = pickAutoModel(freeOnly, score, 'eco');
    expect(pick.tier).toBe('fast');
    expect(pick.provider).toBe('openrouter');
    expect(pick.modelId).toBe('openrouter/free');
  });

  it('falls back to free frontier models when only free OpenRouter models exist', () => {
    const freeFrontier: BackendModelInfo[] = [
      {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'Nemotron 3 Super (Free)',
        provider: 'openrouter',
      },
      { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (Free)', provider: 'openrouter' },
      { id: 'poolside/laguna-m.1:free', name: 'Laguna M.1 (Free)', provider: 'openrouter' },
    ];
    const pick = pickAutoModel(freeFrontier, 90, 'max');
    expect(pick.provider).toBe('openrouter');
    expect(pick.modelId).toBe('nvidia/nemotron-3-super-120b-a12b:free');
  });
});
