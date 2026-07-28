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

type CognitoBearerPick = {
  token: string;
  source: string;
  tokenUse: string;
  hasEmail: boolean;
};

/**
 * Resolve Cognito JWT Authorization headers for LaunchPad MCP.
 *
 * LaunchPad frontend sends localStorage "token" (Cognito **id** JWT) so the
 * backend can read `email` via findOrCreateUserFromCognitoPayload. Access
 * tokens usually have no email and auth fails with "Authentication failed".
 *
 * Hub MCP does not use Cognito JWTs as the MCP bearer — see hub-mcp-auth.ts
 * (silent /oauth/hub-consent → Hub MCP session token).
 *
 * R&D Pulse uses {@link getPulseCognitoAuthHeaders} (Hub **access** token).
 */
export async function getCognitoAuthHeaders(): Promise<Record<string, string>> {
  try {
    const session = await ensureAuthenticatedSession();
    const picked = pickLaunchpadBearerToken(session.idToken, session.accessToken);
    if (picked) {
      log(
        `[BackendAuth] LaunchPad MCP using Cognito ${picked.source} ` +
          `(token_use=${picked.tokenUse}, hasEmail=${picked.hasEmail})`
      );
      return { Authorization: `Bearer ${picked.token}` };
    }
  } catch (error) {
    logWarn('[BackendAuth] Could not resolve Cognito token:', error);
    throw error;
  }

  throw new Error('Sign in required to authenticate Launchpad MCP');
}

/**
 * Resolve Cognito JWT Authorization headers for R&D Pulse MCP.
 *
 * Pulse validates the bearer via Hub `GET /api/auth/me` and requires a Hub
 * Cognito **access** token (same as Pulse web `eip_access_token`).
 */
export async function getPulseCognitoAuthHeaders(): Promise<Record<string, string>> {
  try {
    const session = await ensureAuthenticatedSession();
    const picked = pickPulseBearerToken(session.idToken, session.accessToken);
    if (picked) {
      log(
        `[BackendAuth] R&D Pulse MCP using Cognito ${picked.source} ` +
          `(token_use=${picked.tokenUse}, hasEmail=${picked.hasEmail})`
      );
      return { Authorization: `Bearer ${picked.token}` };
    }
  } catch (error) {
    logWarn('[BackendAuth] Could not resolve Cognito access token for Pulse:', error);
    throw error;
  }

  throw new Error('Sign in required to authenticate R&D Pulse MCP');
}

function collectCognitoCandidates(
  idToken: string | undefined,
  accessToken: string | undefined
): Array<{ token: string; source: string }> {
  const candidates: Array<{ token: string; source: string }> = [];
  const id = idToken?.trim() || '';
  const access = accessToken?.trim() || '';
  if (id) candidates.push({ token: id, source: 'idToken' });
  if (access && access !== id) candidates.push({ token: access, source: 'accessToken' });
  return candidates;
}

function pickLaunchpadBearerToken(
  idToken: string | undefined,
  accessToken: string | undefined
): CognitoBearerPick | null {
  const scored = collectCognitoCandidates(idToken, accessToken).map(({ token, source }) => {
    const tokenUse = peekJwtClaim(token, 'token_use') || 'unknown';
    const hasEmail = Boolean(peekJwtClaim(token, 'email'));
    // Prefer id tokens / tokens with email (LaunchPad user resolution requirement).
    const score = (tokenUse === 'id' ? 4 : 0) + (hasEmail ? 3 : 0) + (source === 'idToken' ? 1 : 0);
    return { token, source, tokenUse, hasEmail, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best?.token) return null;
  return {
    token: best.token,
    source: best.source,
    tokenUse: best.tokenUse,
    hasEmail: best.hasEmail,
  };
}

function pickPulseBearerToken(
  idToken: string | undefined,
  accessToken: string | undefined
): CognitoBearerPick | null {
  const candidates: Array<{ token: string; source: string }> = [];
  const id = idToken?.trim() || '';
  const access = accessToken?.trim() || '';
  if (access) candidates.push({ token: access, source: 'accessToken' });
  else if (id) candidates.push({ token: id, source: 'idToken' });

  const scored = candidates.map(({ token, source }) => {
    const tokenUse = peekJwtClaim(token, 'token_use') || 'unknown';
    const hasEmail = Boolean(peekJwtClaim(token, 'email'));
    const score =
      (tokenUse === 'access' ? 4 : 0) + (source === 'accessToken' ? 3 : 0) + (hasEmail ? 1 : 0);
    return { token, source, tokenUse, hasEmail, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best?.token) return null;
  return {
    token: best.token,
    source: best.source,
    tokenUse: best.tokenUse,
    hasEmail: best.hasEmail,
  };
}

function peekJwtClaim(token: string, claim: string): string | undefined {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return undefined;
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;
    const value = payload[claim];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Single `--header` value for mcp-remote: `Authorization: Bearer <jwt>` (LaunchPad id JWT). */
export async function getCognitoBearerAuthHeader(): Promise<string> {
  const headers = await getCognitoAuthHeaders();
  return `Authorization: ${headers.Authorization}`;
}

/** Single `--header` value for mcp-remote: Hub Cognito access JWT for R&D Pulse. */
export async function getPulseCognitoBearerAuthHeader(): Promise<string> {
  const headers = await getPulseCognitoAuthHeaders();
  return `Authorization: ${headers.Authorization}`;
}
