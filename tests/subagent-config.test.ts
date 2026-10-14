import { describe, expect, it } from 'vitest';
import {
  encodeSubagentModel,
  normalizeSubagentConfig,
  parseSubagentModel,
} from '../src/shared/subagent-config';

describe('subagent configuration', () => {
  it('encodes provider-qualified models and keeps bare ids on the parent provider', () => {
    const value = encodeSubagentModel('gemini', 'gemini-3.6-flash');
    expect(parseSubagentModel(value)).toEqual({
      provider: 'gemini',
      model: 'gemini-3.6-flash',
    });
    expect(parseSubagentModel('/models/qwen.gguf')).toEqual({ model: '/models/qwen.gguf' });
    expect(parseSubagentModel('')).toEqual({ model: '' });
  });

  it('preserves legacy defaults and rejects duplicate or invalid roles', () => {
    const config = normalizeSubagentConfig();
    expect(config.maxConcurrent).toBe(3);
    expect(config.presets.map((preset) => preset.name)).toContain('reviewer');
    expect(() => normalizeSubagentConfig({ ...config, maxConcurrent: 0 })).toThrow();
    expect(() =>
      normalizeSubagentConfig({ ...config, presets: [config.presets[0], config.presets[0]] })
    ).toThrow('unique');
    expect(() => normalizeSubagentConfig({ ...config, defaultAgent: 'missing' })).toThrow(
      'Unknown'
    );
  });

  it('normalizes blank tool names while retaining explicit no-tools restrictions', () => {
    const config = normalizeSubagentConfig();
    config.presets[0].allowedTools = ['  ', ' read '];
    expect(normalizeSubagentConfig(config).presets[0].allowedTools).toEqual(['read']);
    config.presets[0].allowedTools = ['  '];
    expect(normalizeSubagentConfig(config).presets[0].allowedTools).toEqual([]);
  });
});
