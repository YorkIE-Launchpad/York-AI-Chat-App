import { UnauthorizedError } from '@modelcontextprotocol/client';
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function buildOAuthSuccessHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  <p>${body}</p>
  <script>
    (function () {
      function attemptClose() {
        try { window.open('', '_self'); } catch (e) {}
        try { window.close(); } catch (e) {}
      }
      attemptClose();
      setTimeout(attemptClose, 100);
      setTimeout(attemptClose, 500);
      setTimeout(attemptClose, 1200);
    })();
  </script>
</body></html>`;
}

type OpenExternal = (url: string) => Promise<void> | void;

type OAuthTransport = {
  close(): Promise<void>;
  finishAuth(callbackParams: URLSearchParams): Promise<void>;
};

interface OAuthCallbackListener {
  close(): Promise<void>;
  redirectUrl: string;
  waitForCallback(): Promise<URLSearchParams>;
}

export interface PersistedMcpOAuthState {
  serverUrl: string;
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  redirectUrl?: string;
}

interface OAuthProviderOptions {
  clientMetadataUrl?: string;
  openExternal: OpenExternal;
  onPersist?: (record: PersistedMcpOAuthState) => void;
  persisted?: PersistedMcpOAuthState;
  redirectUrl?: string | URL;
  serverUrl?: string;
}

interface ConnectWithOAuthOptions<TTransport extends OAuthTransport> {
  callbackTimeoutMs?: number;
  connect: (transport: TTransport) => Promise<void>;
  createTransport: (provider: OpenCoworkMcpOAuthProvider) => TTransport;
  /**
   * When true, open the system browser and wait for the OAuth callback.
   * When false (default), never open a browser — only try persisted tokens and fail
   * with McpOAuthInteractionRequiredError if sign-in is needed.
   */
  interactiveOAuth?: boolean;
  provider: OpenCoworkMcpOAuthProvider;
}

/** Thrown when MCP OAuth would need a browser login but interactive auth is disabled. */
export class McpOAuthInteractionRequiredError extends Error {
  constructor(message = 'MCP server requires sign-in before it can connect') {
    super(message);
    this.name = 'McpOAuthInteractionRequiredError';
  }
}

/** Thrown when interactive OAuth cannot start (e.g. server missing OAuth discovery). */
export class McpOAuthSetupError extends Error {
  constructor(
    message = 'MCP OAuth could not start. The server did not advertise a browser sign-in flow.'
  ) {
    super(message);
    this.name = 'McpOAuthSetupError';
  }
}

export function isMcpOAuthInteractionRequiredError(error: unknown): boolean {
  if (error instanceof McpOAuthInteractionRequiredError) {
    return true;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'McpOAuthInteractionRequiredError'
  ) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof (error as { message: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '';
  // Defense in depth for plain Errors thrown before typed conversion, or
  // across process/IPC boundaries that lose the custom class.
  return (
    message.includes('requires user action') ||
    message.includes('MCP server requires sign-in') ||
    message.includes('MCP OAuth tokens are invalid or expired')
  );
}

export function isMcpOAuthSetupError(error: unknown): boolean {
  if (error instanceof McpOAuthSetupError) {
    return true;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'McpOAuthSetupError'
  ) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof (error as { message: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '';
  return (
    message.includes('did not advertise') ||
    message.includes('MCP OAuth could not start') ||
    message.includes('missing WWW-Authenticate')
  );
}

/** OAuth errors that should mark the connector failed without a connect-retry loop. */
export function isMcpOAuthNonRetryableError(error: unknown): boolean {
  return isMcpOAuthInteractionRequiredError(error) || isMcpOAuthSetupError(error);
}

function buildClientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    application_type: 'native',
    client_name: 'York IE Growth OS MCP Connector',
    grant_types: ['authorization_code', 'refresh_token'],
    logo_uri: undefined,
    redirect_uris: [redirectUrl],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    tos_uri: undefined,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function safeCloseTransport(transport: OAuthTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Best effort cleanup only.
  }
}

export class OpenCoworkMcpOAuthProvider implements OAuthClientProvider {
  clientMetadataUrl?: string;

  private _clientInformation?: StoredOAuthClientInformation;
  private _codeVerifier?: string;
  private _discoveryState?: OAuthDiscoveryState;
  private _expectedState?: string;
  private _authorizationRedirectStarted = false;
  private _metadata: OAuthClientMetadata;
  private _redirectUrl?: string | URL;
  private readonly _openExternal: OpenExternal;
  private readonly _onPersist?: (record: PersistedMcpOAuthState) => void;
  private readonly _serverUrl?: string;
  private _tokens?: StoredOAuthTokens;

  constructor({
    clientMetadataUrl,
    openExternal,
    onPersist,
    persisted,
    redirectUrl,
    serverUrl,
  }: OAuthProviderOptions) {
    this.clientMetadataUrl = clientMetadataUrl;
    this._openExternal = openExternal;
    this._onPersist = onPersist;
    this._serverUrl = serverUrl ?? persisted?.serverUrl;
    this._redirectUrl = redirectUrl ?? persisted?.redirectUrl ?? 'http://127.0.0.1/callback';
    this._metadata = buildClientMetadata(String(this._redirectUrl));

    if (persisted?.clientInformation) {
      this._clientInformation = persisted.clientInformation;
    }
    if (persisted?.tokens) {
      this._tokens = persisted.tokens;
    }
  }

  get redirectUrl(): string | URL | undefined {
    return this._redirectUrl;
  }

  /** True once {@link redirectToAuthorization} has opened the browser (or attempted to). */
  get authorizationRedirectStarted(): boolean {
    return this._authorizationRedirectStarted;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._metadata;
  }

  setRedirectUrl(redirectUrl: string | URL): void {
    const nextRedirectUrl = String(redirectUrl);
    const previousRedirectUrl =
      this._redirectUrl === undefined ? undefined : String(this._redirectUrl);

    if (previousRedirectUrl && previousRedirectUrl !== nextRedirectUrl) {
      // Dynamic client registrations are tied to redirect URIs.
      this._clientInformation = undefined;
    }

    this._redirectUrl = redirectUrl;
    this._metadata = buildClientMetadata(nextRedirectUrl);
    this.persistState();
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this._clientInformation;
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
    this._clientInformation = clientInformation;
    this.persistState();
  }

  tokens(): StoredOAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this._tokens = tokens;
    this.persistState();
  }

  state(): string {
    this._expectedState = randomBytes(32).toString('base64url');
    return this._expectedState;
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    this._authorizationRedirectStarted = true;
    return this._openExternal(authorizationUrl.toString());
  }

  validateCallbackState(callbackParams: URLSearchParams): void {
    const receivedState = callbackParams.get('state');
    const expectedState = this._expectedState;
    this._expectedState = undefined;

    if (!expectedState || receivedState !== expectedState) {
      throw new Error('MCP OAuth authorization failed: invalid state parameter');
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error('No OAuth code verifier saved');
    }

    return this._codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this._discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this._discoveryState;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') {
      this._clientInformation = undefined;
    }
    if (scope === 'all' || scope === 'tokens') {
      this._tokens = undefined;
    }
    if (scope === 'all' || scope === 'verifier') {
      this._codeVerifier = undefined;
    }
    if (scope === 'all' || scope === 'discovery') {
      this._discoveryState = undefined;
    }

    this.persistState();
  }

  private persistState(): void {
    if (!this._onPersist || !this._serverUrl) {
      return;
    }

    this._onPersist({
      serverUrl: this._serverUrl,
      clientInformation: this._clientInformation,
      tokens: this._tokens,
      redirectUrl: this._redirectUrl === undefined ? undefined : String(this._redirectUrl),
    });
  }
}

export async function createOAuthCallbackListener(
  timeoutMs: number = MCP_OAUTH_CALLBACK_TIMEOUT_MS
): Promise<OAuthCallbackListener> {
  let resolveCallback!: (params: URLSearchParams) => void;
  let rejectCallback!: (error: Error) => void;
  let closedPromise: Promise<void> | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const callbackPromise = new Promise<URLSearchParams>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(404);
      response.end();
      return;
    }

    const address = server.address();
    const port = address && typeof address === 'object' ? (address as AddressInfo).port : 0;
    const parsedUrl = new URL(request.url ?? '', `http://127.0.0.1:${port}`);
    const authorizationCode = parsedUrl.searchParams.get('code');

    if (settled) {
      response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('OAuth callback already handled.');
      return;
    }

    if (authorizationCode) {
      settled = true;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        buildOAuthSuccessHtml('Authorization complete', 'You can return to York GrowthOS now and close this window')
      );
      resolveCallback(new URLSearchParams(parsedUrl.searchParams));
      void closeServer(server);
      return;
    }

    settled = true;
    response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<html><body><h1>Authorization failed</h1><p>Return to York GrowthOS for details.</p></body></html>'
    );
    resolveCallback(new URLSearchParams(parsedUrl.searchParams));
    void closeServer(server);
  });

  const close = async (): Promise<void> => {
    if (closedPromise) {
      return closedPromise;
    }

    closedPromise = (async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await closeServer(server);
    })();

    return closedPromise;
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('Could not determine OAuth callback server address');
  }

  const redirectUrl = `http://127.0.0.1:${address.port}/callback`;

  timer = setTimeout(() => {
    if (settled) {
      return;
    }
    settled = true;
    rejectCallback(
      new Error(
        `Timed out waiting for MCP OAuth authorization after ${Math.floor(timeoutMs / 1000)}s`
      )
    );
    void close();
  }, timeoutMs);

  return {
    close,
    redirectUrl,
    waitForCallback: () => callbackPromise,
  };
}

function hasPersistedOAuthTokens(provider: OpenCoworkMcpOAuthProvider): boolean {
  const tokens = provider.tokens();
  return Boolean(tokens?.access_token || tokens?.refresh_token);
}

function isOAuthDiscoveryFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof (error as { message: unknown }).message === 'string'
        ? (error as { message: string }).message
        : String(error ?? '');
  const lowered = message.toLowerCase();
  return (
    lowered.includes('protected resource metadata') ||
    lowered.includes('well-known oauth') ||
    lowered.includes('oauth-protected-resource') ||
    lowered.includes('does not implement oauth') ||
    lowered.includes('authorization server metadata') ||
    lowered.includes('could not discover') ||
    // SPA HTML / non-JSON body returned from a .well-known URL
    (lowered.includes('unexpected token') && lowered.includes('<'))
  );
}

function toMcpOAuthSetupError(error: unknown): McpOAuthSetupError {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown discovery error';
  return new McpOAuthSetupError(
    'MCP OAuth could not start browser sign-in. The server did not advertise OAuth ' +
      `(missing WWW-Authenticate / protected-resource metadata). ${detail}`
  );
}

export async function connectWithOAuthRetry<TTransport extends OAuthTransport>({
  callbackTimeoutMs = MCP_OAUTH_CALLBACK_TIMEOUT_MS,
  connect,
  createTransport,
  interactiveOAuth = false,
  provider,
}: ConnectWithOAuthOptions<TTransport>): Promise<TTransport> {
  if (hasPersistedOAuthTokens(provider)) {
    const initialTransport = createTransport(provider);

    try {
      await connect(initialTransport);
      return initialTransport;
    } catch (error) {
      await safeCloseTransport(initialTransport);
      if (!(error instanceof UnauthorizedError)) {
        if (isOAuthDiscoveryFailure(error)) {
          throw toMcpOAuthSetupError(error);
        }
        throw error;
      }
      // Persisted tokens were rejected. Only start browser OAuth when the user asked.
      if (!interactiveOAuth) {
        throw new McpOAuthInteractionRequiredError(
          'MCP OAuth tokens are invalid or expired. Connect this server from Settings when you need it.'
        );
      }
    }
  } else if (!interactiveOAuth) {
    throw new McpOAuthInteractionRequiredError(
      'MCP server requires sign-in. Connect this server from Settings when you need it.'
    );
  }

  const listener = await createOAuthCallbackListener(callbackTimeoutMs);
  provider.setRedirectUrl(listener.redirectUrl);

  const oauthTransport = createTransport(provider);
  let connectedTransport: TTransport | null = null;

  try {
    try {
      await connect(oauthTransport);
      connectedTransport = oauthTransport;
      return oauthTransport;
    } catch (error) {
      if (isOAuthDiscoveryFailure(error)) {
        throw toMcpOAuthSetupError(error);
      }
      if (!(error instanceof UnauthorizedError)) {
        throw error;
      }
      // Unauthorized without opening the browser usually means OAuth discovery failed
      // (e.g. 401 with no WWW-Authenticate / protected-resource metadata). Waiting for
      // a callback would leave the UI stuck on "connecting".
      if (!provider.authorizationRedirectStarted) {
        throw new McpOAuthSetupError(
          'MCP OAuth could not start browser sign-in. The server did not advertise OAuth ' +
            '(missing WWW-Authenticate / protected-resource metadata).'
        );
      }
    }

    const callbackParams = await listener.waitForCallback();
    provider.validateCallbackState(callbackParams);
    await oauthTransport.finishAuth(callbackParams);

    const authenticatedTransport = createTransport(provider);
    try {
      await connect(authenticatedTransport);
      connectedTransport = authenticatedTransport;
      return authenticatedTransport;
    } finally {
      if (connectedTransport !== authenticatedTransport) {
        await safeCloseTransport(authenticatedTransport);
      }
    }
  } finally {
    if (connectedTransport !== oauthTransport) {
      await safeCloseTransport(oauthTransport);
    }
    await listener.close();
  }
}
