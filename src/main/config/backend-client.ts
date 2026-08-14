import type { BackendModelInfo } from '../../shared/backend-config';
import { resolveBackendUrl } from '../../shared/backend-config';
import {
  fetchHubGovernanceModels,
  HubAiGovernanceError,
} from '../hub/hub-ai-governance';
import { logWarn } from '../utils/logger';

/**
 * Model picker / auto-resolve catalog from Hub AI Governance:
 * org `GET /models` intersected with the signed-in user's allowed-models
 * (budget / is_free flags attached). Consumer default: usable=true.
 * No fallback to the York proxy static catalog.
 */
export async function fetchBackendModels(options?: {
  usable?: boolean;
  forceRefresh?: boolean;
}): Promise<BackendModelInfo[]> {
  try {
    return await fetchHubGovernanceModels(options);
  } catch (error) {
    if (error instanceof HubAiGovernanceError) {
      logWarn('[Backend] Hub AI governance models failed:', error.status, error.message);
    } else {
      logWarn('[Backend] Hub AI governance models failed:', error);
    }
    return [];
  }
}

export async function checkBackendHealth(
  backendUrl: string = resolveBackendUrl()
): Promise<boolean> {
  const base = backendUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}
