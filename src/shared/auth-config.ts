import { DEFAULT_ATLASSIAN_MCP_URL } from './mcp-defaults';
import { APP_DATA_ENV_VAR } from './app-data-env';

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
const DEFAULT_DESKTOP_OAUTH_REDIRECT = 'http://127.0.0.1:19892/auth/callback';

/** Vite dev server port (`vite.config.ts`); OAuth callback is `{origin}/auth/callback`. */
export const VITE_DEV_FRONTEND_OAUTH_PORT = 6767;

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function normalizeLoopbackHostname(hostname: string): string {
  if (hostname === '[::1]' || hostname === '::1') return '127.0.0.1';
  return hostname;
}

function isViteDevOAuthCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHostname(parsed.hostname)) return false;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const path = parsed.pathname.replace(/\/$/, '') || '/';
    return port === String(VITE_DEV_FRONTEND_OAUTH_PORT) && path === '/auth/callback';
  } catch {
    return false;
  }
}

/** True when redirect is the Vite dev OAuth callback (`:6767/auth/callback`). */
export function isHubOAuthViteDevCallbackUrl(url: string): boolean {
  return isViteDevOAuthCallbackUrl(url);
}

function buildViteDevOAuthCallbackUrl(viteDevServerUrl: string): string {
  try {
    const vite = new URL(viteDevServerUrl);
    const host = normalizeLoopbackHostname(vite.hostname);
    const port = vite.port || String(VITE_DEV_FRONTEND_OAUTH_PORT);
    return `http://${host}:${port}/auth/callback`;
  } catch {
    return `http://127.0.0.1:${VITE_DEV_FRONTEND_OAUTH_PORT}/auth/callback`;
  }
}

function readIsPackagedElectron(): boolean | undefined {
  if (typeof process === 'undefined') return undefined;
  if (process.env[APP_DATA_ENV_VAR] === 'dev') {
    return false;
  }
  try {
    // Shared module: only main has electron at runtime; renderer falls through.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.isPackaged;
  } catch {
    return undefined;
  }
}

function readViteDevServerUrl(): string | undefined {
  const fromEnv = readEnv('VITE_DEV_SERVER_URL');
  if (fromEnv) return fromEnv;
  if (typeof process !== 'undefined' && process.env.VITE_DEV_SERVER_URL?.trim()) {
    return process.env.VITE_DEV_SERVER_URL.trim();
  }
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    return `http://127.0.0.1:${VITE_DEV_FRONTEND_OAUTH_PORT}`;
  }
  return undefined;
}

function resolveOAuthDevContext(opts: ResolveHubOAuthRedirectUrlOptions): {
  isPackaged: boolean;
  isDev: boolean;
  viteDev: string | null;
} {
  const isPackaged = opts.isPackaged ?? readIsPackagedElectron() ?? false;
  let viteDev = opts.viteDevServerUrl?.trim() || readViteDevServerUrl() || null;
  const unpackaged =
    opts.isPackaged === false ||
    (opts.isPackaged === undefined && readIsPackagedElectron() === false);
  const isDev =
    !isPackaged &&
    (Boolean(viteDev) ||
      unpackaged ||
      (typeof process !== 'undefined' && process.env.NODE_ENV === 'development'));
  if (isDev && !viteDev) {
    viteDev = `http://127.0.0.1:${VITE_DEV_FRONTEND_OAUTH_PORT}`;
  }
  return { isPackaged, isDev, viteDev };
}

export type ResolveHubOAuthRedirectUrlOptions = {
  explicitRedirect?: string | null;
  frontendUrl?: string | null;
  viteDevServerUrl?: string | null;
  /** When true, never use Vite :6767 callback (packaged app has no Vite). */
  isPackaged?: boolean;
};

/**
 * Hub Google OAuth redirect_uri sent to Hub `/api/auth/google` and used at token exchange.
 * Dev (Vite): `http://localhost:6767/auth/callback` (or `127.0.0.1`) → AuthCallbackPage + relay.
 * Packaged: loopback `19892` (or explicit non-6767 URL).
 */
export function resolveHubOAuthRedirectUrl(
  opts: ResolveHubOAuthRedirectUrlOptions = {}
): string {
  const explicit = opts.explicitRedirect?.trim();
  const { isPackaged, isDev, viteDev } = resolveOAuthDevContext(opts);

  if (explicit) {
    // Only packaged builds must not use :6767 (Vite is not running).
    if (isPackaged && isViteDevOAuthCallbackUrl(explicit)) {
      return DEFAULT_DESKTOP_OAUTH_REDIRECT;
    }
    return normalizeOAuthRedirectUrl(explicit);
  }

  if (isDev && viteDev) {
    return normalizeOAuthRedirectUrl(buildViteDevOAuthCallbackUrl(viteDev));
  }

  const frontend = opts.frontendUrl?.trim();
  if (frontend) {
    try {
      const front = new URL(frontend);
      if (
        isPackaged &&
        isLoopbackHostname(front.hostname) &&
        (front.port || '80') === String(VITE_DEV_FRONTEND_OAUTH_PORT)
      ) {
        return DEFAULT_DESKTOP_OAUTH_REDIRECT;
      }
    } catch {
      /* ignore */
    }
    return normalizeOAuthRedirectUrl(`${trimTrailingSlash(frontend)}/auth/callback`);
  }

  return applyUnpackagedDevOAuthFallback(DEFAULT_DESKTOP_OAUTH_REDIRECT, isPackaged);
}

function applyUnpackagedDevOAuthFallback(
  resolved: string,
  isPackaged: boolean
): string {
  if (isPackaged || resolved !== DEFAULT_DESKTOP_OAUTH_REDIRECT) {
    return resolved;
  }
  return normalizeOAuthRedirectUrl(
    buildViteDevOAuthCallbackUrl(`http://127.0.0.1:${VITE_DEV_FRONTEND_OAUTH_PORT}`)
  );
}

function normalizeOAuthRedirectUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '[::1]' || parsed.hostname === '::1') {
      parsed.hostname = '127.0.0.1';
    }
    const path = parsed.pathname.replace(/\/$/, '') || '/';
    parsed.pathname = path;
    parsed.hash = '';
    return trimTrailingSlash(parsed.toString());
  } catch {
    return trimTrailingSlash(url);
  }
}

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
   * GTM Launchpad MCP endpoint. Prefer GTM_LAUNCHPAD_MCP_URL; otherwise
   * `https://gtm-launchpad.yorkdevs.link/api/mcp`.
   */
  get gtmLaunchpadMcpUrl(): string {
    const explicit =
      readEnv('GTM_LAUNCHPAD_MCP_URL') ?? readEnv('VITE_GTM_LAUNCHPAD_MCP_URL');
    if (explicit) {
      return trimTrailingSlash(explicit);
    }
    return 'https://gtm-launchpad.yorkdevs.link/api/mcp';
  },
  /**
   * Official Atlassian Rovo MCP endpoint (Jira + Confluence).
   * Prefer ATLASSIAN_MCP_URL; otherwise https://mcp.atlassian.com/v1/mcp/authv2.
   */
  get atlassianMcpUrl(): string {
    const explicit = readEnv('ATLASSIAN_MCP_URL') ?? readEnv('VITE_ATLASSIAN_MCP_URL');
    if (explicit) {
      return trimTrailingSlash(explicit);
    }
    return DEFAULT_ATLASSIAN_MCP_URL;
  },
  /**
   * Hub OAuth return URL — same as Launchpad:
   * HUB_OAUTH_REDIRECT_URL / VITE_HUB_OAUTH_REDIRECT_URL, else {FRONTEND_URL}/auth/callback
   */
  get hubOAuthRedirectUrl(): string {
    return resolveHubOAuthRedirectUrl({
      explicitRedirect:
        readEnv('HUB_OAUTH_REDIRECT_URL') ?? readEnv('VITE_HUB_OAUTH_REDIRECT_URL'),
      frontendUrl: readEnv('VITE_FRONTEND_URL') ?? readEnv('FRONTEND_URL'),
      viteDevServerUrl: readViteDevServerUrl(),
      isPackaged: readIsPackagedElectron(),
    });
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
      '19891';
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 19891;
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
   * Dev:  http://zoom-dev.york.ie:19891/callback (+ /etc/hosts → 127.0.0.1)
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
