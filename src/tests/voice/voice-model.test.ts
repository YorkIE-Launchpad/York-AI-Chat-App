import { describe, expect, it, vi } from 'vitest';
import type { BackendModelInfo } from '../../shared/backend-config';
import type { AppConfig } from '../../main/config/config-store';
import {
  matchVoiceModel,
  selectableVoiceModels,
  switchVoiceModel,
  type VoiceModelDeps,
} from '../../main/voice/voice-model';

const MODELS: BackendModelInfo[] = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'gemini' },
  { id: 'gpt-image-2.5', name: 'GPT Image 2.5', provider: 'openai' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai', hasBudget: false },
];

describe('matchVoiceModel', () => {
  it.each([
    ['opus', 'claude-opus-5'],
    ['use Gemini flash', 'gemini-3.6-flash'],
    ['GPT 5.4', 'gpt-5.4'],
    ['sonnet four point six', null],
    ['sonnet 4 point 6', 'claude-sonnet-4.6'],
    ['Claude Sonnet 5', 'claude-sonnet-5'],
  ])('matches "%s"', (spoken, id) => {
    const result = matchVoiceModel(spoken, MODELS);
    if (id === null) expect(result.kind).not.toBe('model');
    else expect(result).toEqual({ kind: 'model', model: MODELS.find((m) => m.id === id) });
  });

  it('recognises auto', () => {
    expect(matchVoiceModel('switch to auto', MODELS)).toEqual({ kind: 'auto' });
  });

  it('returns options when several models match', () => {
    const result = matchVoiceModel('sonnet', MODELS);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.options.map((m) => m.id)).toEqual(['claude-sonnet-5', 'claude-sonnet-4.6']);
    }
  });
});

describe('selectableVoiceModels', () => {
  it('drops image-only and over-budget models', () => {
    const ids = selectableVoiceModels(MODELS).map((m) => m.id);
    expect(ids).not.toContain('gpt-image-2.5');
    expect(ids).not.toContain('gpt-5.6-luna');
    expect(ids).toContain('claude-opus-5');
  });
});

describe('switchVoiceModel', () => {
  function deps(config: Partial<AppConfig> = {}) {
    const saveConfig = vi.fn(async () => undefined);
    const value: VoiceModelDeps = {
      listModels: async () => MODELS,
      getConfig: () =>
        ({ provider: 'anthropic', model: 'claude-sonnet-5', ...config }) as AppConfig,
      saveConfig,
    };
    return { value, saveConfig };
  }

  it('saves the selector payload for the matched model', async () => {
    const { value, saveConfig } = deps();
    const result = await switchVoiceModel('gpt 5.4', value);
    expect(result).toEqual({ ok: true, message: 'Switched to GPT-5.4.' });
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        activeProfileKey: 'openai',
        customProtocol: 'openai',
        model: 'gpt-5.4',
      })
    );
  });

  it('switches to auto', async () => {
    const { value, saveConfig } = deps();
    await switchVoiceModel('auto', value);
    expect(saveConfig).toHaveBeenCalledWith({ model: 'auto' });
  });

  it('does not save when the model is already active or ambiguous', async () => {
    const { value, saveConfig } = deps();
    expect((await switchVoiceModel('Claude Sonnet 5', value)).message).toContain('Already using');
    expect((await switchVoiceModel('sonnet', value)).ok).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
  });
});
