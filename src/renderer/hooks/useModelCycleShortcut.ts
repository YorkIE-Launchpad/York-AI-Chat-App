import { useEffect } from 'react';
import { useAppStore, type GlobalNotice } from '../store';
import type { AppConfig } from '../types';
import {
  createModelCycleKeydownHandler,
  listModelCycleTargets,
  type ModelCycleTarget,
} from '../utils/model-cycle';
import {
  applyBackendManagedCredentials,
  BACKEND_PROXY_PLACEHOLDER_KEY,
  isBackendManagedProvider,
} from '../../shared/backend-config';
import {
  filterModelsForDivision,
  sessionFieldsFromActiveDivision,
} from '../../shared/workspace-division';
import { isGptImage25ModelId } from '../../shared/image-generation';

/**
 * York models come from the backend catalog: cycle only through models the
 * ModelSelector would let the user pick for the active provider and workspace.
 */
function listYorkModelCycleTargets(config: AppConfig): ModelCycleTarget[] {
  if (!isBackendManagedProvider(config.provider)) {
    return listModelCycleTargets(config).filter((target) => target.kind === 'set');
  }
  const state = useAppStore.getState();
  const usable = filterModelsForDivision(
    state.backendModelsCatalog.filter((model) => !isGptImage25ModelId(model.id)),
    sessionFieldsFromActiveDivision(state.activeDivision)
  ).filter((model) => model.provider === config.provider && model.hasBudget !== false);
  if (usable.length <= 1) return [];
  return usable.map((model) => ({ kind: 'model' as const, model: model.id }));
}

function saveYorkModel(config: AppConfig | null, model: string) {
  if (!config || !isBackendManagedProvider(config.provider)) {
    return window.electronAPI.config.save({ model });
  }
  return window.electronAPI.config.save(
    applyBackendManagedCredentials({
      provider: config.provider,
      model,
      apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
    })
  );
}

function noticeForCycledTarget(target: ModelCycleTarget): GlobalNotice {
  if (target.kind === 'set') {
    return {
      id: `notice-model-cycled-${Date.now()}`,
      type: 'success',
      message: `Switched to ${target.name} (${target.model})`,
      messageKey: 'chat.modelCycledSet',
      messageValues: { name: target.name, model: target.model },
    };
  }

  return {
    id: `notice-model-cycled-${Date.now()}`,
    type: 'success',
    message: `Switched model to ${target.model}`,
    messageKey: 'chat.modelCycled',
    messageValues: { model: target.model },
  };
}

/**
 * Desktop equivalent of the pi TUI's Ctrl+P / Shift+Ctrl+P model cycle.
 * Persists via config.switchSet / config.save so the next turn hot-swaps
 * through the existing AgentSession.setModel path in the agent runner.
 */
export function useModelCycleShortcut() {
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    const cycleInFlight = { current: false };
    const handler = createModelCycleKeydownHandler({
      getContext: () => {
        const state = useAppStore.getState();
        return {
          config: state.appConfig,
          settingsOpen: state.showSettings,
          configModalOpen: false,
        };
      },
      cycleInFlight,
      listTargets: listYorkModelCycleTargets,
      switchSet: (id) => window.electronAPI.config.switchSet({ id }),
      saveModel: async (model) => {
        const result = await saveYorkModel(useAppStore.getState().appConfig, model);
        useAppStore.getState().setAppConfig(result.config);
      },
      onCycled: (target) => {
        setGlobalNotice(noticeForCycledTarget(target));
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        setGlobalNotice({
          id: `notice-model-cycle-error-${Date.now()}`,
          type: 'error',
          message,
        });
      },
    });

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setGlobalNotice]);
}
