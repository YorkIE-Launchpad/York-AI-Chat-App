import {
  isBackendManagedProvider,
  isBackendProxyPlaceholderKey,
} from '../../shared/backend-config';
import { ensureAuthenticatedSession } from '../auth/session';
import { log, logWarn } from '../utils/logger';

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

/**
 * Resolve Cognito JWT Authorization headers for LaunchPad MCP.
 * Prefers accessToken (LaunchPad frontend / MCP docs); falls back to idToken.
 */
export async function getCognitoAuthHeaders(): Promise<Record<string, string>> {
  try {
    const session = await ensureAuthenticatedSession();
    // LaunchPad auth middleware + MCP README: Cognito access token for Hub/LaunchPad APIs.
    const token = (session.accessToken || session.idToken || '').trim();
    if (token) {
      const kind = session.accessToken?.trim() ? 'accessToken' : 'idToken';
      const tokenUse = peekJwtClaim(token, 'token_use') || 'unknown';
      log(`[BackendAuth] LaunchPad MCP using Cognito ${kind} (token_use=${tokenUse})`);
      return { Authorization: `Bearer ${token}` };
    }
  } catch (error) {
    logWarn('[BackendAuth] Could not resolve Cognito token:', error);
    throw error;
  }

  throw new Error('Sign in required to authenticate Launchpad MCP');
}

function peekJwtClaim(token: string, claim: string): string | undefined {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return undefined;
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;
    const value = payload[claim];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Single `--header` value for mcp-remote: `Authorization: Bearer <jwt>`. */
export async function getCognitoBearerAuthHeader(): Promise<string> {
  const headers = await getCognitoAuthHeaders();
  return `Authorization: ${headers.Authorization}`;
}
