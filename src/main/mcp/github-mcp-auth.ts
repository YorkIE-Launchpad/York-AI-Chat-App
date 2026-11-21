/**
 * GitHub's hosted MCP does not support OAuth dynamic client registration.
 * The public client id is used to open the browser. The client secret stays on
 * the York backend, which exchanges the authorization code.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { StoredOAuthClientInformation } from '@modelcontextprotocol/client';
import { authConfig } from '../../shared/auth-config';
import { resolveBackendUrl } from '../../shared/backend-config';
import { getBackendAuthHeaders } from '../config/backend-auth';

const execFileAsync = promisify(execFile);

const GITHUB_TOKEN_PATH = '/login/oauth/access_token';

export const GITHUB_MCP_SIGN_IN_HELP =
  'GitHub MCP needs York’s GitHub OAuth app. Set GITHUB_OAUTH_CLIENT_ID in the desktop app. ' +
  'Keep GITHUB_OAUTH_CLIENT_SECRET on the backend only. Callback URL: http://127.0.0.1/callback. ' +
  'Or set GITHUB_MCP_TOKEN to a personal access token.';

export function githubMcpSignInHelp(): string {
  return GITHUB_MCP_SIGN_IN_HELP;
}

export function readGithubMcpTokenFromEnv(): string | undefined {
  const value = process.env.GITHUB_MCP_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** Public client id only. The secret is added by POST /connectors/oauth/github/token. */
export function githubOAuthStaticClient(): StoredOAuthClientInformation | undefined {
  const clientId = authConfig.githubOAuthClientId;
  if (!clientId) return undefined;
  return {
    client_id: clientId,
    token_endpoint_auth_method: 'none',
  };
}

export function isGithubOAuthTokenRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.origin !== 'https://github.com') return false;
  const path = parsed.pathname.replace(/\/$/, '');
  if (path !== GITHUB_TOKEN_PATH) return false;
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  return method === 'POST';
}

async function readUrlEncodedBody(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<URLSearchParams> {
  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (!body) return new URLSearchParams();
  if (typeof body === 'string') return new URLSearchParams(body);
  if (body instanceof URLSearchParams) return body;
  if (body instanceof Uint8Array) return new URLSearchParams(new TextDecoder().decode(body));
  if (body instanceof ArrayBuffer) return new URLSearchParams(new TextDecoder().decode(body));
  return new URLSearchParams();
}

/** Redirect GitHub's token endpoint to the backend so the client secret never leaves the server. */
export function createGithubBackendTokenFetch(fallback: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (!isGithubOAuthTokenRequest(input, init)) {
      return fallback(input, init);
    }
    const fields = await readUrlEncodedBody(input, init);
    const body: Record<string, string> = {};
    for (const key of ['grant_type', 'code', 'redirect_uri', 'code_verifier', 'refresh_token']) {
      const value = fields.get(key)?.trim();
      if (value) body[key] = value;
    }
    if (!body.grant_type) body.grant_type = 'authorization_code';

    const url = `${resolveBackendUrl().replace(/\/+$/, '')}/connectors/oauth/github/token`;
    const headers = await getBackendAuthHeaders();
    const response = await fallback(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        response.status === 503
          ? 'GitHub OAuth is not configured on the backend. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET there.'
          : `GitHub token exchange failed (${response.status}): ${detail}`
      );
    }
    return response;
  };
}

/** Env token, otherwise `gh auth token` when the GitHub CLI is logged in. */
export async function resolveGithubMcpAccessToken(): Promise<string | undefined> {
  const fromEnv = readGithubMcpTokenFromEnv();
  if (fromEnv) return fromEnv;

  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 4000,
      windowsHide: true,
    });
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}
