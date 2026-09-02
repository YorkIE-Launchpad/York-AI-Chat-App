import {
  extractYorkLlmContextWindow,
  formatYorkLlmModelName,
  resolveYorkLlmBaseUrl,
} from '../../shared/york-llm-config';
import type { ProviderModelInfo } from '../../renderer/types';
import { fetchOllamaModelIndex } from './ollama-api';

export interface YorkLlmModelInfo extends ProviderModelInfo {
  contextWindow?: number;
}

const MODELS_CACHE_TTL_MS = 60_000;
let modelsCache: { expiresAt: number; models: YorkLlmModelInfo[] } | null = null;

export async function listYorkLlmModels(options?: {
  forceRefresh?: boolean;
}): Promise<YorkLlmModelInfo[]> {
  const now = Date.now();
  if (!options?.forceRefresh && modelsCache && modelsCache.expiresAt > now) {
    return modelsCache.models;
  }

  const baseUrl = resolveYorkLlmBaseUrl();
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }
  const data = text ? JSON.parse(text) : {};
  const rows = Array.isArray(data?.data) ? data.data : [];
  const models: YorkLlmModelInfo[] = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;
    models.push({
      id,
      name: formatYorkLlmModelName(id),
      contextWindow: extractYorkLlmContextWindow(row),
    });
  }
  if (models.length === 0) {
    // Fallback to shared OpenAI-compatible parser if response shape differs slightly.
    const index = await fetchOllamaModelIndex({ baseUrl, apiKey: '' });
    for (const model of index.models) {
      models.push({
        ...model,
        name: formatYorkLlmModelName(model.id),
      });
    }
  }

  modelsCache = {
    expiresAt: now + MODELS_CACHE_TTL_MS,
    models,
  };
  return models;
}

export async function getYorkLlmModelContextWindow(modelId: string): Promise<number | undefined> {
  const models = await listYorkLlmModels();
  return models.find((model) => model.id === modelId)?.contextWindow;
}

export function resetYorkLlmModelsCacheForTests(): void {
  modelsCache = null;
}
