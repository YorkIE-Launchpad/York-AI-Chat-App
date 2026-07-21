import {
  isBackendManagedProvider,
  isBackendProxyPlaceholderKey,
} from '../../shared/backend-config';
import { ensureAuthenticatedSession } from '../auth/session';
import { logWarn } from '../utils/logger';

/**
 * Resolve the credential Electron should send to the local LLM proxy.
 * Persisted config keeps a placeholder; request-time uses Cognito JWT.
 */
export async function resolveBackendClientApiKey(options: {
  provider?: string;
  apiKey?: string | null;
}): Promise<string> {
  const configuredKey = options.apiKey?.trim() || '';
  const useCognito =
    isBackendManagedProvider(options.provider) || isBackendProxyPlaceholderKey(configuredKey);

  if (!useCognito) {
    return configuredKey;
  }

  try {
    const session = await ensureAuthenticatedSession();
    const token = (session.accessToken || session.idToken || '').trim();
    if (token) return token;
  } catch (error) {
    logWarn('[BackendAuth] Could not resolve Cognito token for proxy:', error);
    throw error;
  }

  throw new Error('No Cognito token available for backend proxy authentication');
}

export async function getBackendAuthHeaders(): Promise<Record<string, string>> {
  const token = await resolveBackendClientApiKey({ provider: 'anthropic' });
  return { Authorization: `Bearer ${token}` };
}
