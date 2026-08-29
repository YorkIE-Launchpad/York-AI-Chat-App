export type BackendProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter';

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
  ],
  gemini: [
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
  ],
  openrouter: [
    { id: 'openrouter/auto-beta', name: 'OpenRouter Auto' },
    { id: 'openrouter/auto', name: 'OpenRouter Auto (Classic)' },
    { id: 'openrouter/free', name: 'OpenRouter Free' },
    { id: 'meta-llama/llama-3.2-3b-instruct:free', name: 'Llama 3.2 3B (Free)' },
    { id: 'openai/gpt-oss-20b:free', name: 'GPT-OSS 20B (Free)' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano (Free)' },
    { id: 'poolside/laguna-xs-2.1:free', name: 'Laguna XS 2.1 (Free)' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free)' },
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (Free)' },
    { id: 'qwen/qwen3-next-80b-a3b-instruct:free', name: 'Qwen3 Next 80B (Free)' },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (Free)' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super (Free)' },
    { id: 'poolside/laguna-m.1:free', name: 'Laguna M.1 (Free)' },
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
    { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5' },
    { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
    { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8' },
    { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
    // Temporarily hidden — re-enable later:
    // { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    // { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { id: 'google/gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
    { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
  ],
};

const ENV_KEY_BY_PROVIDER: Record<BackendProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export function providerHasKey(provider: BackendProvider): boolean {
  // OpenRouter is user-BYOK only — always list catalog entries; client gates on user key.
  if (provider === 'openrouter') return true;
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
  // OpenRouter never uses a server env key.
  if (provider === 'openrouter') return undefined;
  const key = process.env[ENV_KEY_BY_PROVIDER[provider]]?.trim();
  return key || undefined;
}
