import type { BackendModelInfo } from '../../shared/backend-config';
import { resolveBackendUrl } from '../../shared/backend-config';
import { logWarn } from '../utils/logger';
import { getBackendAuthHeaders } from './backend-auth';

export async function fetchBackendModels(
  backendUrl: string = resolveBackendUrl()
): Promise<BackendModelInfo[]> {
  const base = backendUrl.replace(/\/+$/, '');
  const url = `${base}/models`;
  try {
    const authHeaders = await getBackendAuthHeaders();
    const response = await fetch(url, {
      headers: authHeaders,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      logWarn('[Backend] GET /models failed:', response.status, response.statusText);
      return [];
    }
    const data = (await response.json()) as { models?: BackendModelInfo[] };
    return Array.isArray(data.models) ? data.models : [];
  } catch (error) {
    logWarn('[Backend] Could not reach LLM proxy at', url, error);
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
