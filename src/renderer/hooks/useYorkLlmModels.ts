import { useCallback, useEffect, useState } from 'react';
import type { ProviderModelInfo } from '../types';
import {
  DEFAULT_YORK_LLM_BASE_URL,
  formatYorkLlmModelName,
  isYorkLlmBaseUrl,
  resolveYorkLlmBaseUrl,
} from '../../shared/york-llm-config';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export interface YorkLlmModelOption extends ProviderModelInfo {
  contextWindow?: number;
}

export function useYorkLlmModels(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const [models, setModels] = useState<YorkLlmModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);

  const loadModels = useCallback(
    (silent?: boolean) => {
      if (!isElectron || !enabled) return;
      if (!silent) setIsLoading(true);
      void window.electronAPI.config
        .listYorkLlmModels()
        .then((items) => {
          setModels(items);
          setIsUnavailable(items.length === 0);
        })
        .catch(() => {
          setModels([]);
          setIsUnavailable(true);
        })
        .finally(() => {
          if (!silent) setIsLoading(false);
        });
    },
    [enabled]
  );

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  return {
    models,
    isLoading,
    isUnavailable,
    loadModels,
    baseUrl: resolveYorkLlmBaseUrl(),
    defaultBaseUrl: DEFAULT_YORK_LLM_BASE_URL,
  };
}

export function isYorkLlmSelection(
  provider: string | undefined,
  baseUrl: string | undefined,
  model: string | undefined
): boolean {
  if (provider !== 'ollama' || !model?.trim()) return false;
  if (isYorkLlmBaseUrl(baseUrl)) return true;
  return model.includes('.gguf');
}

export function yorkLlmDisplayName(modelId: string, name?: string): string {
  if (name && name !== modelId) return name;
  return formatYorkLlmModelName(modelId);
}

export { isYorkLlmBaseUrl, resolveYorkLlmBaseUrl };
