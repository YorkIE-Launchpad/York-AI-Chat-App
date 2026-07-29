function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** Map Hub API origin to Hub MCP URL (`api.` → `mcp.` + `/mcp`). */
function deriveHubMcpUrlFromApiUrl(apiUrl: string): string | undefined {
  try {
    const parsed = new URL(apiUrl);
    if (!parsed.hostname.startsWith('api.')) {
      return undefined;
    }
    parsed.hostname = `mcp.${parsed.hostname.slice('api.'.length)}`;
    parsed.pathname = '/mcp';
    parsed.search = '';
    parsed.hash = '';
    return trimTrailingSlash(parsed.toString());
  } catch {
    return undefined;
  }
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
const DEFAULT_FRONTEND_URL = 'http://localhost:6767';

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
   * R&D Pulse MCP endpoint. Prefer RND_PULSE_MCP_URL; otherwise
   * `https://pulse.yorkdevs.link/mcp`.
   */
  get rndPulseMcpUrl(): string {
    const explicit = readEnv('RND_PULSE_MCP_URL') ?? readEnv('VITE_RND_PULSE_MCP_URL');
    if (explicit) {
      return trimTrailingSlash(explicit);
    }
    return 'https://pulse.yorkdevs.link/mcp';
  },
  /**
   * Hub MCP endpoint. Prefer HUB_MCP_URL / VITE_HUB_MCP_URL; otherwise derive
   * from Hub API host (`api.*` → `mcp.*` + `/mcp`); last resort UAT.
   */
  get hubMcpUrl(): string {
    const explicit = readEnv('HUB_MCP_URL') ?? readEnv('VITE_HUB_MCP_URL');
    if (explicit) {
      return trimTrailingSlash(explicit);
    }
    const derived = deriveHubMcpUrlFromApiUrl(this.hubApiUrl);
    if (derived) {
      return derived;
    }
    return 'https://mcp.uat-hub.yorkdevs.link/mcp';
  },
  /**
   * GTM Pulse MCP endpoint. Prefer GTM_PULSE_MCP_URL; otherwise
   * `https://gtm-pulse.yorkdevs.link/mcp`.
   */
  get gtmPulseMcpUrl(): string {
    const explicit = readEnv('GTM_PULSE_MCP_URL') ?? readEnv('VITE_GTM_PULSE_MCP_URL');
    if (explicit) {
      return trimTrailingSlash(explicit);
    }
    return 'https://gtm-pulse.yorkdevs.link/mcp';
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
  /**
   * Loopback port for connector OAuth local delivery (Slack/Gmail/Drive, and Zoom bridge hop).
   * Override with CONNECTOR_OAUTH_CALLBACK_PORT.
   */
  get connectorOauthCallbackPort(): number {
    const raw =
      readEnv('CONNECTOR_OAUTH_CALLBACK_PORT') ??
      readEnv('VITE_CONNECTOR_OAUTH_CALLBACK_PORT') ??
      '6789';
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 6789;
  },
  /**
   * Loopback redirect used by Slack / Gmail / Drive, and as Zoom's local code-delivery target
   * when ZOOM_OAUTH_REDIRECT_URI points at the public York backend bridge.
   */
  get connectorOauthRedirectUri(): string {
    return `http://127.0.0.1:${this.connectorOauthCallbackPort}/callback`;
  },
  /**
   * Zoom authorize + token-exchange redirect_uri (required for Connect Zoom).
   * Prod: https://<york-public>/oauth/zoom/callback
   * Dev:  http://zoom-dev.york.ie:6789/callback (+ /etc/hosts → 127.0.0.1)
   */
  get zoomOauthRedirectUri(): string | undefined {
    const raw = readEnv('ZOOM_OAUTH_REDIRECT_URI') ?? readEnv('VITE_ZOOM_OAUTH_REDIRECT_URI');
    const trimmed = raw?.trim();
    return trimmed || undefined;
  },
  get slackClientId(): string | undefined {
    return readEnv('SLACK_CLIENT_ID') ?? readEnv('VITE_SLACK_CLIENT_ID');
  },
  get slackClientSecret(): string | undefined {
    return readEnv('SLACK_CLIENT_SECRET') ?? readEnv('VITE_SLACK_CLIENT_SECRET');
  },
  /** Optional hard pin: Slack team_id that may connect the Slack MCP connector. */
  get slackAllowedTeamId(): string | undefined {
    return readEnv('SLACK_ALLOWED_TEAM_ID') ?? readEnv('VITE_SLACK_ALLOWED_TEAM_ID');
  },
  get googleConnectorClientId(): string | undefined {
    return (
      readEnv('GOOGLE_CONNECTOR_CLIENT_ID') ??
      readEnv('GOOGLE_CLIENT_ID') ??
      readEnv('VITE_GOOGLE_CONNECTOR_CLIENT_ID')
    );
  },
  get googleConnectorClientSecret(): string | undefined {
    return (
      readEnv('GOOGLE_CONNECTOR_CLIENT_SECRET') ??
      readEnv('GOOGLE_CLIENT_SECRET') ??
      readEnv('VITE_GOOGLE_CONNECTOR_CLIENT_SECRET')
    );
  },
  get zoomConnectorClientId(): string | undefined {
    return readEnv('ZOOM_CONNECTOR_CLIENT_ID') ?? readEnv('VITE_ZOOM_CONNECTOR_CLIENT_ID');
  },
  get zoomConnectorClientSecret(): string | undefined {
    return readEnv('ZOOM_CONNECTOR_CLIENT_SECRET') ?? readEnv('VITE_ZOOM_CONNECTOR_CLIENT_SECRET');
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
