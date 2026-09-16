import type { BackendModelInfo } from '../../shared/backend-config';
import { useAppStore } from '../store';

export const BACKEND_MODELS_CATALOG_REFRESH_EVENT = 'york:models-catalog-refreshed';

export async function refreshBackendModelsCatalog(options?: {
  usable?: boolean;
  forceRefresh?: boolean;
}): Promise<BackendModelInfo[]> {
  if (!window.electronAPI?.config?.listBackendModels) {
    return [];
  }
  const items = await window.electronAPI.config.listBackendModels({
    usable: options?.usable !== false,
    forceRefresh: options?.forceRefresh,
  });
  if (items.length > 0 || options?.forceRefresh) {
    useAppStore.getState().setBackendModelsCatalog(items);
  }
  return items;
}

export function notifyBackendModelsCatalogRefreshed(): void {
  window.dispatchEvent(new CustomEvent(BACKEND_MODELS_CATALOG_REFRESH_EVENT));
}
