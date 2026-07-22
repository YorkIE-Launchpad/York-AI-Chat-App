function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function readEnv(key: string): string | undefined {
  const fromProcess = typeof process !== 'undefined' ? process.env[key] : undefined;
  if (fromProcess?.trim()) {
    return fromProcess.trim();
  }
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const env = import.meta.env as Record<string, string | undefined>;
    const viteVal = env[`VITE_${key}`] ?? env[key];
    if (typeof viteVal === 'string' && viteVal.trim()) {
      return viteVal.trim();
    }
  }
  return undefined;
}

const DEFAULT_HUB_API_URL = 'https://api.uat-hub.yorkdevs.link';
const DEFAULT_FRONTEND_URL = 'http://localhost:5173';

export const authConfig = {
  get hubApiUrl(): string {
    return trimTrailingSlash(
      readEnv('HUB_API_URL') ?? readEnv('VITE_HUB_API_URL') ?? DEFAULT_HUB_API_URL
    );
  },
  /**
   * LaunchPad MCP endpoint. Prefer LAUNCHPAD_MCP_URL; otherwise production
   * `https://launchpad.yorkdevs.link/mcp` (UAT MCP currently rejects its Host header).
   */
  get launchpadMcpUrl(): string {
    const explicit = readEnv('LAUNCHPAD_MCP_URL') ?? readEnv('VITE_LAUNCHPAD_MCP_URL');
    if (explicit) {
      return trimTrailingSlash(explicit);
    }
    return 'https://launchpad.yorkdevs.link/mcp';
  },
  /**
   * Hub OAuth return URL — same as Launchpad:
   * HUB_OAUTH_REDIRECT_URL / VITE_HUB_OAUTH_REDIRECT_URL, else {FRONTEND_URL}/auth/callback
   */
  get hubOAuthRedirectUrl(): string {
    const frontendUrl = trimTrailingSlash(
      readEnv('VITE_FRONTEND_URL') ?? readEnv('FRONTEND_URL') ?? DEFAULT_FRONTEND_URL
    );
    return trimTrailingSlash(
      readEnv('HUB_OAUTH_REDIRECT_URL') ??
        readEnv('VITE_HUB_OAUTH_REDIRECT_URL') ??
        `${frontendUrl}/auth/callback`
    );
  },
  get cognitoUserPoolId(): string | undefined {
    return (
      readEnv('AWS_COGNITO_USER_POOL_ID') ??
      readEnv('COGNITO_USER_POOL_ID') ??
      readEnv('VITE_COGNITO_USER_POOL_ID')
    );
  },
  get cognitoAppClientId(): string | undefined {
    return (
      readEnv('AWS_COGNITO_APP_CLIENT_ID') ??
      readEnv('COGNITO_CLIENT_ID') ??
      readEnv('COGNITO_APP_CLIENT_ID') ??
      readEnv('VITE_COGNITO_APP_CLIENT_ID')
    );
  },
  get authAllowedDomain(): string | undefined {
    const raw = readEnv('AUTH_ALLOWED_DOMAIN');
    if (!raw?.trim()) return undefined;
    let domain = raw.trim().replace(/^["']|["']$/g, '');
    if (domain && !domain.startsWith('@')) {
      domain = `@${domain}`;
    }
    return domain;
  },
  /** Loopback relay for OAuth code from system browser → Electron main (default port 19890). */
  get oauthRelayBaseUrl(): string {
    const port =
      readEnv('VECOS_OAUTH_RELAY_PORT') ?? readEnv('VITE_VECOS_OAUTH_RELAY_PORT') ?? '19890';
    return `http://127.0.0.1:${port}`;
  },
};

/** POST target for browser OAuth callback (same-origin via Vite proxy in dev). */
export function resolveOAuthRelayPostUrl(): string {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return '/vecos-oauth-relay/relay';
    }
  }
  return `${authConfig.oauthRelayBaseUrl}/relay`;
}
