/**
 * Hub MCP auth — Cognito/Hub session → Hub MCP bearer (no browser OAuth UI).
 *
 * Hub MCP does not accept Cognito JWTs as the MCP Authorization header. The
 * Hub frontend consent page posts Cognito tokens to `/oauth/hub-consent`; Hub
 * MCP then issues its own access token. We automate that handshake with the
 * already-signed-in Hub session.
 */
import { createHash, randomBytes } from 'crypto';
import { authConfig } from '../../shared/auth-config';
import { ensureAuthenticatedSession, getCurrentSession, tryRefreshSession } from '../auth/session';
import { log } from '../utils/logger';

const HUB_MCP_REDIRECT_URI = 'http://127.0.0.1:19741/callback';
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

interface HubMcpTokenCache {
  accessToken: string;
  expiresAtMs: number;
  mcpBaseUrl: string;
}

interface RegisteredClient {
  clientId: string;
  mcpBaseUrl: string;
}

let tokenCache: HubMcpTokenCache | null = null;
let registeredClient: RegisteredClient | null = null;
let inFlight: Promise<Record<string, string>> | null = null;

function resolveHubMcpBaseUrl(): string {
  try {
    const mcpUrl = new URL(authConfig.hubMcpUrl);
    return mcpUrl.origin;
  } catch {
    return 'https://mcp.uat-hub.yorkdevs.link';
  }
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function peekJwtExpMs(token: string): number | null {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function extractSetCookie(header: string | null): string | null {
  if (!header) return null;
  // Node fetch may join multiple Set-Cookie with ", " — take name=value only.
  const first = header.split(/,(?=\s*[^;=]+=)/)[0] ?? header;
  const pair = first.split(';')[0]?.trim();
  return pair || null;
}

async function ensureRegisteredClient(mcpBaseUrl: string): Promise<string> {
  if (registeredClient && registeredClient.mcpBaseUrl === mcpBaseUrl) {
    return registeredClient.clientId;
  }

  const res = await fetch(`${mcpBaseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'York IE VECOS Hub MCP',
      redirect_uris: [HUB_MCP_REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body = (await res.json()) as { client_id?: string; error?: string };
  if (!res.ok || !body.client_id) {
    throw new Error(body.error || `Hub MCP client registration failed (${res.status})`);
  }
  registeredClient = { clientId: body.client_id, mcpBaseUrl };
  return body.client_id;
}

async function startAuthorizeRequest(
  mcpBaseUrl: string,
  clientId: string,
  challenge: string
): Promise<{ requestId: string; consentCookie: string | null }> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: HUB_MCP_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: base64Url(randomBytes(16)),
    scope: 'mcp:tools',
    resource: `${mcpBaseUrl}/mcp`,
  });

  const res = await fetch(`${mcpBaseUrl}/oauth/authorize?${params.toString()}`, {
    method: 'GET',
    redirect: 'manual',
  });

  const location = res.headers.get('location');
  if (res.status !== 302 || !location) {
    throw new Error(`Hub MCP authorize did not redirect (status ${res.status})`);
  }

  const redirectUrl = new URL(location, mcpBaseUrl);
  const requestId = redirectUrl.searchParams.get('request_id');
  if (!requestId) {
    throw new Error('Hub MCP authorize redirect missing request_id');
  }

  const consentCookie = extractSetCookie(res.headers.get('set-cookie'));
  return { requestId, consentCookie };
}

async function submitHubConsent(options: {
  mcpBaseUrl: string;
  requestId: string;
  consentCookie: string | null;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  userEmail?: string;
}): Promise<string> {
  const body: Record<string, string> = {
    requestId: options.requestId,
    accessToken: options.accessToken,
    refreshToken: options.refreshToken,
  };
  if (options.idToken) body.idToken = options.idToken;
  if (options.userEmail) body.userEmail = options.userEmail;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.consentCookie) {
    headers.Cookie = options.consentCookie;
  }

  const res = await fetch(`${options.mcpBaseUrl}/oauth/hub-consent`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { redirectUrl?: string; error?: string };
  if (!res.ok || !data.redirectUrl) {
    throw new Error(data.error || `Hub MCP consent failed (${res.status})`);
  }

  const redirectUrl = new URL(data.redirectUrl);
  const code = redirectUrl.searchParams.get('code');
  if (!code) {
    const err =
      redirectUrl.searchParams.get('error_description') ||
      redirectUrl.searchParams.get('error') ||
      'Hub MCP consent redirect missing authorization code';
    throw new Error(err);
  }
  return code;
}

async function exchangeAuthorizationCode(options: {
  mcpBaseUrl: string;
  clientId: string;
  code: string;
  verifier: string;
}): Promise<{ accessToken: string; expiresAtMs: number }> {
  const res = await fetch(`${options.mcpBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: HUB_MCP_REDIRECT_URI,
      client_id: options.clientId,
      code_verifier: options.verifier,
      resource: `${options.mcpBaseUrl}/mcp`,
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || `Hub MCP token exchange failed (${res.status})`
    );
  }

  const jwtExp = peekJwtExpMs(data.access_token);
  const expiresAtMs =
    jwtExp ??
    Date.now() + (typeof data.expires_in === 'number' ? data.expires_in * 1000 : 55 * 60 * 1000);

  return { accessToken: data.access_token, expiresAtMs };
}

async function acquireHubMcpAccessToken(): Promise<string> {
  const mcpBaseUrl = resolveHubMcpBaseUrl();

  if (
    tokenCache &&
    tokenCache.mcpBaseUrl === mcpBaseUrl &&
    tokenCache.expiresAtMs > Date.now() + TOKEN_EXPIRY_BUFFER_MS
  ) {
    return tokenCache.accessToken;
  }

  let session = await ensureAuthenticatedSession();
  if (!session.refreshToken?.trim() || !session.accessToken?.trim()) {
    await tryRefreshSession();
    session = getCurrentSession() ?? session;
  }

  const accessToken = session.accessToken?.trim() || '';
  const refreshToken = session.refreshToken?.trim() || '';
  if (!accessToken || !refreshToken) {
    throw new Error('Hub sign-in required (missing Cognito access/refresh token for Hub MCP)');
  }

  const clientId = await ensureRegisteredClient(mcpBaseUrl);
  const { verifier, challenge } = createPkce();
  const { requestId, consentCookie } = await startAuthorizeRequest(mcpBaseUrl, clientId, challenge);

  log(`[HubMcpAuth] Auto-consenting Hub MCP authorize request ${requestId}`);
  const code = await submitHubConsent({
    mcpBaseUrl,
    requestId,
    consentCookie,
    accessToken,
    refreshToken,
    idToken: session.idToken?.trim() || undefined,
    userEmail: session.user?.email,
  });

  const tokens = await exchangeAuthorizationCode({
    mcpBaseUrl,
    clientId,
    code,
    verifier,
  });

  tokenCache = {
    accessToken: tokens.accessToken,
    expiresAtMs: tokens.expiresAtMs,
    mcpBaseUrl,
  };
  log('[HubMcpAuth] Acquired Hub MCP access token via silent hub-consent');
  return tokens.accessToken;
}

/** Authorization headers for Hub MCP streamable-http (Hub MCP session bearer). */
export async function getHubMcpAuthHeaders(): Promise<Record<string, string>> {
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const accessToken = await acquireHubMcpAccessToken();
        return { Authorization: `Bearer ${accessToken}` };
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

/** Clear cached Hub MCP token (e.g. after logout or auth failure). */
export function clearHubMcpAuthCache(): void {
  tokenCache = null;
}
