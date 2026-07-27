import type { BackendCloudProvider, BackendModelInfo } from './backend-config';

/**
 * Full cloud model catalog for the picker UI.
 * Keep in sync with `backend/src/models.ts` CATALOG.
 */
export const BACKEND_MODEL_CATALOG: Record<
  BackendCloudProvider,
  Array<{ id: string; name: string }>
> = {
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
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6', name: 'GPT-5.6' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'o3', name: 'o3' },
    { id: 'o4-mini', name: 'o4 Mini' },
  ],
  gemini: [
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
    { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
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
    { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
  ],
};

export function listAllBackendModels(): BackendModelInfo[] {
  const models: BackendModelInfo[] = [];
  for (const provider of Object.keys(BACKEND_MODEL_CATALOG) as BackendCloudProvider[]) {
    for (const entry of BACKEND_MODEL_CATALOG[provider]) {
      models.push({ ...entry, provider });
    }
  }
  return models;
}
