export type SharedProviderType = 'anthropic' | 'custom' | 'openai' | 'gemini' | 'ollama';

export type SharedCustomProtocolType = 'anthropic' | 'openai' | 'gemini';

export interface SharedProviderPreset {
  name: string;
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
  keyPlaceholder: string;
  keyHint: string;
}

export interface SharedProviderPresets {
  anthropic: SharedProviderPreset;
  custom: SharedProviderPreset;
  openai: SharedProviderPreset;
  gemini: SharedProviderPreset;
  ollama: SharedProviderPreset;
}

export interface ModelInputGuidance {
  placeholder: string;
  hint: string;
}

export const API_PROVIDER_PRESETS: SharedProviderPresets = {
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-fable-5', name: 'claude-fable-5' },
      { id: 'claude-opus-5', name: 'claude-opus-5' },
      { id: 'claude-opus-4-8', name: 'claude-opus-4-8' },
      { id: 'claude-sonnet-5', name: 'claude-sonnet-5' },
      { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5' },
      { id: 'claude-opus-4-7', name: 'claude-opus-4-7' },
      { id: 'claude-opus-4-6', name: 'claude-opus-4-6' },
      { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' },
    ],
    keyPlaceholder: 'sk-ant-...',
    keyHint: 'Get from console.anthropic.com',
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      // Temporarily hidden — re-enable later:
      // { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol' },
      // { id: 'gpt-5.6-terra', name: 'gpt-5.6-terra' },
      // { id: 'gpt-5.6', name: 'gpt-5.6' },
      { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
      { id: 'gpt-5.4', name: 'gpt-5.4' },
      { id: 'gpt-5.4-mini', name: 'gpt-5.4-mini' },
      { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' },
      { id: 'o3', name: 'o3' },
      { id: 'o4-mini', name: 'o4-mini' },
      { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
      { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
    ],
    keyPlaceholder: 'sk-...',
    keyHint: 'Get from platform.openai.com',
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: [
      { id: 'gemini-3.7-flash', name: 'gemini-3.7-flash' },
      { id: 'gemini-3.6-flash', name: 'gemini-3.6-flash' },
      { id: 'gemini-3.5-flash', name: 'gemini-3.5-flash' },
      { id: 'gemini-3.5-flash-lite', name: 'gemini-3.5-flash-lite' },
      { id: 'gemini-3.1-pro-preview', name: 'gemini-3.1-pro-preview' },
      { id: 'gemini-3.1-flash-lite', name: 'gemini-3.1-flash-lite' },
    ],
    keyPlaceholder: 'AIza...',
    keyHint: 'Get from aistudio.google.com',
  },
  ollama: {
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'qwen3.5:0.8b', name: 'qwen3.5:0.8b' },
      { id: 'llama3.2:latest', name: 'llama3.2:latest' },
      { id: 'deepseek-r1:latest', name: 'deepseek-r1:latest' },
    ],
    keyPlaceholder: 'Optional',
    keyHint:
      'Most Ollama deployments can leave this empty; fill in a key if your proxy requires auth',
  },
  custom: {
    name: 'More models',
    baseUrl: '',
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
      { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
      { id: 'kimi-k2-thinking', name: 'kimi-k2-thinking' },
      { id: 'glm-5', name: 'glm-5' },
      { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
      { id: 'qwen-max', name: 'qwen-max' },
      { id: 'grok-code-fast-1', name: 'grok-code-fast-1' },
      { id: 'mistral-large-latest', name: 'mistral-large-latest' },
    ],
    keyPlaceholder: 'sk-xxx',
    keyHint: 'Enter your API Key',
  },
};

export const PI_AI_CURATED_PRESETS: Record<string, { piProvider: string; pick: string[] }> = {
  anthropic: {
    piProvider: 'anthropic',
    pick: [
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ],
  },
  openai: {
    piProvider: 'openai',
    pick: [
      // Temporarily hidden — re-enable later:
      // 'gpt-5.6-sol',
      // 'gpt-5.6-terra',
      // 'gpt-5.6',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'o3',
      'o4-mini',
    ],
  },
  gemini: {
    piProvider: 'google',
    pick: [
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite',
    ],
  },
};

export function getModelInputGuidance(
  provider: SharedProviderType,
  customProtocol: SharedCustomProtocolType = 'anthropic'
): ModelInputGuidance {
  if (provider === 'custom' && customProtocol === 'openai') {
    return {
      placeholder: 'deepseek-chat, deepseek-reasoner, qwen-max, gpt-5.6-luna',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'custom' && customProtocol === 'gemini') {
    return {
      placeholder: 'gemini-3.7-flash, gemini-3.6-flash, gemini-3.1-pro-preview',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'custom') {
    return {
      placeholder: 'glm-5, kimi-k2-thinking, claude-sonnet-5',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'openai') {
    return {
      placeholder: 'gpt-5.6-luna, gpt-5.4, gpt-5.4-mini',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'ollama') {
    return {
      placeholder: 'qwen3.5:0.8b, llama3.2:latest, deepseek-r1:latest',
      hint: 'Use the exact model ID returned by your Ollama server.',
    };
  }

  if (provider === 'gemini') {
    return {
      placeholder: 'gemini-3.7-flash, gemini-3.6-flash, gemini-3.1-pro-preview',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  return {
    placeholder: 'claude-sonnet-5, claude-opus-5, claude-fable-5',
    hint: 'Use the exact model ID for the selected protocol or endpoint.',
  };
}
