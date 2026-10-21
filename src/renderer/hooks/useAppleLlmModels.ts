import { useCallback, useEffect, useState } from 'react';
import type { ProviderModelInfo } from '../types';
import {
  APPLE_LLM_CONTEXT_WINDOW,
  appleLlmSelectionPayload,
  formatAppleLlmModelName,
  isAppleLlmBaseUrl,
  isAppleLlmSelection,
  type AppleLlmStatus,
} from '../../shared/apple-llm-config';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export interface AppleLlmModelOption extends ProviderModelInfo {
  contextWindow?: number;
}

export function useAppleLlmModels(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const [models, setModels] = useState<AppleLlmModelOption[]>([]);
  const [status, setStatus] = useState<AppleLlmStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const load = useCallback(
    (silent?: boolean) => {
      if (!isElectron || !enabled) return;
      if (!silent) setIsLoading(true);
      void Promise.all([
        window.electronAPI.config.listAppleLlmModels(),
        window.electronAPI.config.getAppleLlmStatus(),
      ])
        .then(([items, nextStatus]) => {
          setModels(items.map((m) => ({ ...m, contextWindow: APPLE_LLM_CONTEXT_WINDOW })));
          setStatus(nextStatus);
        })
        .catch(() => {
          setModels([]);
          setStatus({ available: false, serverRunning: false, reason: 'unknown' });
        })
        .finally(() => {
          if (!silent) setIsLoading(false);
        });
    },
    [enabled]
  );

  useEffect(() => {
    load();
  }, [load]);

  /** Start `fm serve` (first selection, or after the server died). */
  const ensureServer = useCallback(async (): Promise<boolean> => {
    if (!isElectron) return false;
    setIsStarting(true);
    setStartError(null);
    try {
      const next = await window.electronAPI.config.ensureAppleLlmServer();
      setStatus(next);
      return next.serverRunning;
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setIsStarting(false);
    }
  }, []);

  return {
    models,
    status,
    isLoading,
    isStarting,
    startError,
    loadModels: load,
    ensureServer,
  };
}

export function appleLlmDisplayName(modelId: string, name?: string): string {
  if (name && name !== modelId) return name;
  return formatAppleLlmModelName(modelId);
}

export { appleLlmSelectionPayload, isAppleLlmBaseUrl, isAppleLlmSelection };
