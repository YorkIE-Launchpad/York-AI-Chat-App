import { authConfig } from '../../shared/auth-config';
import { log, logWarn } from '../utils/logger';
import {
  assertAllowedGoogleConnectorEmail,
  assertAllowedSlackWorkspace,
  assertAllowedZoomConnectorEmail,
  isAllowedGoogleConnectorEmail,
  isAllowedSlackWorkspace,
  isAllowedZoomConnectorEmail,
} from './connector-allowlist';
import { runDesktopOAuthFlow } from './connector-oauth';
import { connectorTokenStore } from './connector-token-store';
import type {
  ConnectorId,
  ConnectorOauthConfig,
  ConnectorStatus,
  ConnectorTokenRecord,
  ConnectorTokenRefreshResult,
} from './connector-types';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar.events',
];
const SLACK_SCOPES = [
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'search:read',
  'users:read',
  'users:read.email',
  'chat:write',
];
/** Zoom General App scopes for identity, live meetings, and RTMS start. */
const ZOOM_SCOPES = [
  'user:read:user',
  'user:read:email',
  'meeting:read:list_meetings',
  'meeting:read:meeting',
  'meeting:update:participant_rtms_app_status',
];

const ALL_CONNECTOR_IDS: ConnectorId[] = ['slack', 'google', 'zoom'];

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;
/** When expiresAt is missing, refresh after this age (Google access tokens last ~1h). */
const ACCESS_TOKEN_STALE_WITHOUT_EXPIRY_MS = 50 * 60_000;

function parseExpiresAtFromExpiresIn(expiresIn: unknown): number | null {
  const seconds =
    typeof expiresIn === 'number'
      ? expiresIn
      : typeof expiresIn === 'string'
        ? Number(expiresIn)
        : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Date.now() + seconds * 1000;
}

export function connectorAccessTokenNeedsRefresh(
  record: Pick<ConnectorTokenRecord, 'expiresAt' | 'updatedAt' | 'refreshToken'>,
  now = Date.now(),
  options?: { forceRefresh?: boolean }
): boolean {
  if (options?.forceRefresh) {
    return true;
  }
  if (record.expiresAt != null) {
    return record.expiresAt - now <= ACCESS_TOKEN_EXPIRY_BUFFER_MS;
  }
  // Missing expiry: still refresh periodically when we have a refresh token.
  return (
    Boolean(record.refreshToken) && now - record.updatedAt >= ACCESS_TOKEN_STALE_WITHOUT_EXPIRY_MS
  );
}

class ConnectorManager {
  private refreshInFlight = new Map<ConnectorId, Promise<ConnectorTokenRecord>>();

  constructor() {
    connectorTokenStore.clearLegacyGoogleTokens();
  }

  getStatuses(): ConnectorStatus[] {
    return ALL_CONNECTOR_IDS.map((connectorId) => {
      const record = connectorTokenStore.load(connectorId);
      return {
        connectorId,
        connected: Boolean(record?.accessToken),
        accountEmail: record?.accountEmail ?? null,
        accountName: record?.accountName ?? null,
        workspaceName: record?.workspaceName ?? null,
      };
    });
  }

  getStatus(connectorId: ConnectorId): ConnectorStatus {
    return this.getStatuses().find(
      (status) => status.connectorId === connectorId
    ) as ConnectorStatus;
  }

  isConnected(connectorId: ConnectorId): boolean {
    return Boolean(connectorTokenStore.load(connectorId)?.accessToken);
  }

  async connect(connectorId: ConnectorId): Promise<ConnectorStatus> {
    const oauth = this.getOauthConfig(connectorId);
    const redirectUri = connectorId === 'zoom' ? authConfig.zoomOauthRedirectUri : undefined;
    if (connectorId === 'zoom' && !redirectUri) {
      throw new Error(
        'ZOOM_OAUTH_REDIRECT_URI is required. Use https://<york-public>/oauth/zoom/callback in prod, or http://zoom-dev.york.ie:19891/callback with /etc/hosts for local dev.'
      );
    }
    const authResult = await runDesktopOAuthFlow({
      authorizeUrl: oauth.authorizeUrl,
      clientId: oauth.clientId,
      scopes: oauth.scopes,
      extraAuthorizeParams: oauth.extraAuthorizeParams,
      redirectUri,
    });

    const tokenPayload = await this.exchangeAuthorizationCode(
      connectorId,
      oauth,
      authResult.code,
      authResult.codeVerifier,
      authResult.redirectUri
    );
    const record = await this.buildTokenRecord(connectorId, tokenPayload);
    this.assertRecordAllowed(record);
    connectorTokenStore.save(record);
    log('[ConnectorManager] Connected connector', {
      connectorId,
      accountEmail: record.accountEmail,
    });
    return this.getStatus(connectorId);
  }

  disconnect(connectorId: ConnectorId): void {
    connectorTokenStore.clear(connectorId);
  }

  async ensureFreshAccessToken(
    connectorId: ConnectorId,
    options?: { forceRefresh?: boolean }
  ): Promise<ConnectorTokenRecord> {
    const inFlight = this.refreshInFlight.get(connectorId);
    if (inFlight) {
      return inFlight;
    }

    const run = this.ensureFreshAccessTokenUnlocked(connectorId, options);
    this.refreshInFlight.set(connectorId, run);
    try {
      return await run;
    } finally {
      if (this.refreshInFlight.get(connectorId) === run) {
        this.refreshInFlight.delete(connectorId);
      }
    }
  }

  private async ensureFreshAccessTokenUnlocked(
    connectorId: ConnectorId,
    options?: { forceRefresh?: boolean }
  ): Promise<ConnectorTokenRecord> {
    const current = connectorTokenStore.load(connectorId);
    if (!current) {
      throw new Error(`${connectorId} connector is not connected`);
    }
    this.enforceStoredRecordAllowed(current);
    if (connectorId === 'slack') {
      this.assertSlackUserToken(current.accessToken, 'Stored Slack connector token');
    }

    if (!connectorAccessTokenNeedsRefresh(current, Date.now(), options)) {
      return current;
    }
    if (!current.refreshToken?.trim()) {
      logWarn('[ConnectorManager] Connector access token expired without refresh token', {
        connectorId,
      });
      throw new Error(
        `${connectorId} access token expired. Disconnect and reconnect the connector.`
      );
    }

    const oauth = this.getOauthConfig(connectorId);
    const refreshed = await this.refreshAccessToken(connectorId, oauth, current.refreshToken);
    if (!refreshed.accessToken?.trim()) {
      throw new Error(`${connectorId} token refresh did not return an access token`);
    }
    const nextRecord: ConnectorTokenRecord = {
      ...current,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || current.refreshToken,
      expiresAt: refreshed.expiresAt ?? current.expiresAt ?? null,
      tokenType: refreshed.tokenType ?? current.tokenType,
      scope: refreshed.scope?.length ? refreshed.scope : current.scope,
      updatedAt: Date.now(),
    };
    this.enforceStoredRecordAllowed(nextRecord);
    connectorTokenStore.save(nextRecord);
    log('[ConnectorManager] Refreshed connector access token', {
      connectorId,
      expiresAt: nextRecord.expiresAt,
    });
    return nextRecord;
  }

  private getOauthConfig(connectorId: ConnectorId): ConnectorOauthConfig {
    if (connectorId === 'slack') {
      if (!authConfig.slackClientId || !authConfig.slackClientSecret) {
        throw new Error('Slack OAuth credentials are missing');
      }
      const extraAuthorizeParams: Record<string, string> = {
        user_scope: SLACK_SCOPES.join(','),
      };
      const allowedTeamId = authConfig.slackAllowedTeamId?.trim();
      if (allowedTeamId) {
        extraAuthorizeParams.team = allowedTeamId;
      }
      return {
        clientId: authConfig.slackClientId,
        clientSecret: authConfig.slackClientSecret,
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        scopes: [],
        extraAuthorizeParams,
      };
    }
    if (connectorId === 'zoom') {
      if (!authConfig.zoomConnectorClientId || !authConfig.zoomConnectorClientSecret) {
        throw new Error('Zoom OAuth credentials are missing');
      }
      return {
        clientId: authConfig.zoomConnectorClientId,
        clientSecret: authConfig.zoomConnectorClientSecret,
        authorizeUrl: 'https://zoom.us/oauth/authorize',
        tokenUrl: 'https://zoom.us/oauth/token',
        scopes: ZOOM_SCOPES,
      };
    }
    if (!authConfig.googleConnectorClientId || !authConfig.googleConnectorClientSecret) {
      throw new Error('Google connector OAuth credentials are missing');
    }
    return {
      clientId: authConfig.googleConnectorClientId,
      clientSecret: authConfig.googleConnectorClientSecret,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: GOOGLE_SCOPES,
      extraAuthorizeParams: {
        access_type: 'offline',
        prompt: 'consent',
        hd: 'york.ie',
      },
    };
  }

  private async exchangeAuthorizationCode(
    connectorId: ConnectorId,
    oauth: ConnectorOauthConfig,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      code_verifier: codeVerifier,
      ...oauth.extraTokenParams,
    });
    const response = await fetch(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) {
      throw new Error(
        `${connectorId} OAuth token exchange failed: ${String(payload.error || response.statusText)}`
      );
    }
    return payload;
  }

  private async refreshAccessToken(
    connectorId: ConnectorId,
    oauth: ConnectorOauthConfig,
    refreshToken: string
  ): Promise<ConnectorTokenRefreshResult> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
    });
    const response = await fetch(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) {
      throw new Error(
        `${connectorId} token refresh failed: ${String(payload.error || response.statusText)}`
      );
    }
    if (connectorId === 'slack') {
      const parsed = this.parseSlackTokenPayload(payload, {
        requireAuthedUser: false,
        allowTopLevelAccessToken: true,
      });
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        tokenType: 'user',
        scope: parsed.scope,
      };
    }
    return {
      accessToken: String(payload.access_token || ''),
      refreshToken:
        typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
          ? payload.refresh_token
          : undefined,
      expiresAt: parseExpiresAtFromExpiresIn(payload.expires_in),
      tokenType: typeof payload.token_type === 'string' ? payload.token_type : undefined,
      scope:
        typeof payload.scope === 'string'
          ? payload.scope
              .split(/[ ,]+/)
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined,
    };
  }

  private async buildTokenRecord(
    connectorId: ConnectorId,
    payload: Record<string, unknown>
  ): Promise<ConnectorTokenRecord> {
    const slackTokenPayload =
      connectorId === 'slack'
        ? this.parseSlackTokenPayload(payload, {
            requireAuthedUser: true,
            allowTopLevelAccessToken: false,
          })
        : null;
    const accessToken = String(slackTokenPayload?.accessToken || payload.access_token || '');
    if (!accessToken) {
      throw new Error(`${connectorId} OAuth response did not include an access token`);
    }
    const baseRecord: ConnectorTokenRecord = {
      connectorId,
      accessToken,
      refreshToken:
        typeof (connectorId === 'slack'
          ? slackTokenPayload?.refreshToken
          : payload.refresh_token) === 'string' &&
        String(
          connectorId === 'slack' ? slackTokenPayload?.refreshToken : payload.refresh_token
        ).trim()
          ? String(
              connectorId === 'slack' ? slackTokenPayload?.refreshToken : payload.refresh_token
            )
          : undefined,
      expiresAt: parseExpiresAtFromExpiresIn(
        connectorId === 'slack' ? slackTokenPayload?.rawExpiresIn : payload.expires_in
      ),
      tokenType:
        connectorId === 'slack'
          ? 'user'
          : typeof payload.token_type === 'string'
            ? payload.token_type
            : undefined,
      scope:
        connectorId === 'slack' ? (slackTokenPayload?.scope ?? []) : this.extractScopes(payload),
      updatedAt: Date.now(),
      accountEmail: null,
      accountId: null,
      accountName: null,
      workspaceName: null,
    };

    if (connectorId === 'slack') {
      const identity = await this.fetchSlackIdentity(accessToken);
      const record: ConnectorTokenRecord = {
        ...baseRecord,
        accountId: identity.userId,
        accountName: identity.userName,
        accountEmail: identity.email,
        workspaceName: identity.teamName,
        workspaceId: identity.teamId,
        workspaceUrl: identity.teamUrl,
      };
      this.assertRecordAllowed(record);
      return record;
    }

    if (connectorId === 'google') {
      const profile = await this.fetchGmailProfile(accessToken);
      const record: ConnectorTokenRecord = {
        ...baseRecord,
        accountEmail: profile.emailAddress,
        accountId: profile.emailAddress,
        accountName: profile.emailAddress,
      };
      this.assertRecordAllowed(record);
      return record;
    }

    if (connectorId === 'zoom') {
      const identity = await this.fetchZoomIdentity(accessToken);
      const record: ConnectorTokenRecord = {
        ...baseRecord,
        accountEmail: identity.email,
        accountId: identity.userId,
        accountName: identity.displayName,
        workspaceName: identity.accountId,
      };
      this.assertRecordAllowed(record);
      return record;
    }

    throw new Error(`Unsupported connector: ${connectorId}`);
  }

  private extractScopes(payload: Record<string, unknown>): string[] {
    if (typeof payload.scope === 'string') {
      return payload.scope
        .split(/[ ,]+/)
        .map((value) => value.trim())
        .filter(Boolean);
    }
    return [];
  }

  private async fetchSlackIdentity(accessToken: string): Promise<{
    userId: string | null;
    userName: string | null;
    email: string | null;
    teamName: string | null;
    teamId: string | null;
    teamUrl: string | null;
  }> {
    const authTest = await this.fetchJson('https://slack.com/api/auth.test', accessToken);
    const userId = typeof authTest.user_id === 'string' ? authTest.user_id : null;
    const teamName = typeof authTest.team === 'string' ? authTest.team : null;
    const teamId = typeof authTest.team_id === 'string' ? authTest.team_id : null;
    const teamUrl = typeof authTest.url === 'string' ? authTest.url : null;

    let userName: string | null = null;
    let email: string | null = null;
    if (userId) {
      const userInfo = await this.fetchJson(
        `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
        accessToken
      );
      const profile =
        userInfo.user && typeof userInfo.user === 'object'
          ? (
              userInfo.user as {
                profile?: { real_name?: string; email?: string; display_name?: string };
              }
            ).profile
          : undefined;
      userName = profile?.real_name || profile?.display_name || null;
      email = profile?.email || null;
    }
    return { userId, userName, email, teamName, teamId, teamUrl };
  }

  private async fetchGmailProfile(accessToken: string): Promise<{ emailAddress: string | null }> {
    const payload = await this.fetchJson(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      accessToken
    );
    return {
      emailAddress: typeof payload.emailAddress === 'string' ? payload.emailAddress : null,
    };
  }

  private async fetchZoomIdentity(accessToken: string): Promise<{
    userId: string | null;
    email: string | null;
    displayName: string | null;
    accountId: string | null;
  }> {
    const payload = await this.fetchJson('https://api.zoom.us/v2/users/me', accessToken);
    const first = typeof payload.first_name === 'string' ? payload.first_name : '';
    const last = typeof payload.last_name === 'string' ? payload.last_name : '';
    const displayName =
      typeof payload.display_name === 'string' && payload.display_name.trim()
        ? payload.display_name
        : [first, last].filter(Boolean).join(' ').trim() || null;
    return {
      userId: typeof payload.id === 'string' ? payload.id : null,
      email: typeof payload.email === 'string' ? payload.email : null,
      displayName,
      accountId: typeof payload.account_id === 'string' ? payload.account_id : null,
    };
  }

  private assertRecordAllowed(record: ConnectorTokenRecord): void {
    if (record.connectorId === 'slack') {
      assertAllowedSlackWorkspace({
        teamId: record.workspaceId,
        teamName: record.workspaceName,
        teamUrl: record.workspaceUrl,
        allowedTeamId: authConfig.slackAllowedTeamId,
      });
      return;
    }
    if (record.connectorId === 'zoom') {
      assertAllowedZoomConnectorEmail(record.accountEmail);
      return;
    }
    assertAllowedGoogleConnectorEmail(record.accountEmail, 'Google');
  }

  private enforceStoredRecordAllowed(record: ConnectorTokenRecord): void {
    const allowed =
      record.connectorId === 'slack'
        ? isAllowedSlackWorkspace({
            teamId: record.workspaceId,
            teamName: record.workspaceName,
            teamUrl: record.workspaceUrl,
            allowedTeamId: authConfig.slackAllowedTeamId,
          })
        : record.connectorId === 'zoom'
          ? isAllowedZoomConnectorEmail(record.accountEmail)
          : isAllowedGoogleConnectorEmail(record.accountEmail);

    if (allowed) {
      return;
    }

    logWarn('[ConnectorManager] Clearing disallowed connector token', {
      connectorId: record.connectorId,
      accountEmail: record.accountEmail,
      workspaceName: record.workspaceName,
      workspaceId: record.workspaceId,
    });
    connectorTokenStore.clear(record.connectorId);
    this.assertRecordAllowed(record);
  }

  private async fetchJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) {
      throw new Error(this.formatApiError(payload, response.statusText));
    }
    return payload;
  }

  private parseSlackTokenPayload(
    payload: Record<string, unknown>,
    options: { requireAuthedUser: boolean; allowTopLevelAccessToken: boolean }
  ): {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number | null;
    rawExpiresIn?: number;
    scope: string[];
  } {
    const authedUser =
      payload.authed_user && typeof payload.authed_user === 'object'
        ? (payload.authed_user as Record<string, unknown>)
        : null;
    if (options.requireAuthedUser && !authedUser) {
      throw new Error('Slack OAuth response did not include an authed_user token');
    }

    const candidatePayload = authedUser ?? (options.allowTopLevelAccessToken ? payload : null);
    const accessToken =
      candidatePayload && typeof candidatePayload.access_token === 'string'
        ? candidatePayload.access_token.trim()
        : '';
    if (!accessToken) {
      throw new Error('Slack OAuth response did not include a user access token');
    }
    this.assertSlackUserToken(accessToken, 'Slack connector token');

    const refreshToken =
      candidatePayload && typeof candidatePayload.refresh_token === 'string'
        ? candidatePayload.refresh_token.trim()
        : '';
    const rawExpiresInSource =
      candidatePayload && candidatePayload.expires_in != null
        ? candidatePayload.expires_in
        : payload.expires_in;
    const expiresAt = parseExpiresAtFromExpiresIn(rawExpiresInSource);
    const rawExpiresInSeconds =
      typeof rawExpiresInSource === 'number'
        ? rawExpiresInSource
        : typeof rawExpiresInSource === 'string'
          ? Number(rawExpiresInSource)
          : NaN;
    const rawExpiresIn =
      Number.isFinite(rawExpiresInSeconds) && rawExpiresInSeconds > 0
        ? rawExpiresInSeconds
        : undefined;

    const scopeSource =
      candidatePayload && typeof candidatePayload.scope === 'string' ? candidatePayload : payload;
    return {
      accessToken,
      refreshToken: refreshToken || undefined,
      expiresAt,
      rawExpiresIn,
      scope: this.extractScopes(scopeSource),
    };
  }

  private assertSlackUserToken(accessToken: string, label: string): void {
    const trimmed = accessToken.trim();
    if (!trimmed) {
      throw new Error(`${label} is missing`);
    }
    if (trimmed.startsWith('xoxb-')) {
      throw new Error(`${label} must be a Slack user token, not a bot token`);
    }
    if (!trimmed.startsWith('xoxp-') && !trimmed.startsWith('xoxe.xoxp-')) {
      throw new Error(`${label} must be a Slack user token`);
    }
  }

  private formatApiError(payload: Record<string, unknown>, statusText: string): string {
    const error = payload.error;
    if (typeof error === 'string' && error.trim()) return error;
    if (error && typeof error === 'object') {
      const nested = error as { message?: unknown; status?: unknown; code?: unknown };
      if (typeof nested.message === 'string' && nested.message.trim()) {
        return nested.message;
      }
      if (typeof nested.status === 'string' && nested.status.trim()) {
        return nested.status;
      }
      if (typeof nested.code === 'string' || typeof nested.code === 'number') {
        return String(nested.code);
      }
    }
    return statusText || 'Request failed';
  }
}

export const connectorManager = new ConnectorManager();
