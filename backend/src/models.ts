export type BackendProvider = 'anthropic' | 'openai' | 'gemini' | 'typesafe' | 'york-llm';

export interface BackendModelEntry {
  id: string;
  name: string;
  provider: BackendProvider;
}

const CATALOG: Record<BackendProvider, Array<{ id: string; name: string }>> = {
  anthropic: [
    { id: 'claude-fable-5', name: 'Claude Fable 5' },
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  ],
  openai: [
    // Temporarily hidden — re-enable later:
    // { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    // { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    // { id: 'gpt-5.6', name: 'GPT-5.6' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'o3', name: 'o3' },
    { id: 'o4-mini', name: 'o4 Mini' },
    { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
    { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
  ],
  gemini: [
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
  ],
  // Decision API (System One) — not listed as a chat model in Auto.
  typesafe: [],
  // Clients list York LLM models from the llama.cpp /v1/models endpoint.
  'york-llm': [],
};

const ENV_KEY_BY_PROVIDER: Record<BackendProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  typesafe: 'TYPESAFE_API_KEY',
  'york-llm': 'YORK_LLM_API_KEY',
};

export function providerHasKey(provider: BackendProvider): boolean {
  const key = process.env[ENV_KEY_BY_PROVIDER[provider]]?.trim();
  return Boolean(key);
}

export function listEnabledModels(): BackendModelEntry[] {
  const models: BackendModelEntry[] = [];
  for (const provider of Object.keys(CATALOG) as BackendProvider[]) {
    if (!providerHasKey(provider)) {
      continue;
    }
    for (const entry of CATALOG[provider]) {
      models.push({ ...entry, provider });
    }
  }
  return models;
}

export function getProviderApiKey(provider: BackendProvider): string | undefined {
  const key = process.env[ENV_KEY_BY_PROVIDER[provider]]?.trim();
  return key || undefined;
}
