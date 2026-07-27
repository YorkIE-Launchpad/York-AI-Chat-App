import { authConfig } from '../../shared/auth-config';
import { log, logWarn } from '../utils/logger';
import {
  assertAllowedGoogleConnectorEmail,
  assertAllowedSlackWorkspace,
  isAllowedGoogleConnectorEmail,
  isAllowedSlackWorkspace,
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

const GOOGLE_GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
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
];

class ConnectorManager {
  getStatuses(): ConnectorStatus[] {
    return (['slack', 'gmail', 'google-drive'] as ConnectorId[]).map((connectorId) => {
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
    const authResult = await runDesktopOAuthFlow({
      authorizeUrl: oauth.authorizeUrl,
      clientId: oauth.clientId,
      scopes: oauth.scopes,
      extraAuthorizeParams: oauth.extraAuthorizeParams,
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

  async ensureFreshAccessToken(connectorId: ConnectorId): Promise<ConnectorTokenRecord> {
    const current = connectorTokenStore.load(connectorId);
    if (!current) {
      throw new Error(`${connectorId} connector is not connected`);
    }
    this.enforceStoredRecordAllowed(current);

    if (!current.expiresAt || current.expiresAt - Date.now() > 60_000) {
      return current;
    }
    if (!current.refreshToken) {
      logWarn('[ConnectorManager] Connector access token expired without refresh token', {
        connectorId,
      });
      return current;
    }

    const oauth = this.getOauthConfig(connectorId);
    const refreshed = await this.refreshAccessToken(connectorId, oauth, current.refreshToken);
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
    if (!authConfig.googleConnectorClientId || !authConfig.googleConnectorClientSecret) {
      throw new Error('Google connector OAuth credentials are missing');
    }
    return {
      clientId: authConfig.googleConnectorClientId,
      clientSecret: authConfig.googleConnectorClientSecret,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: connectorId === 'gmail' ? GOOGLE_GMAIL_SCOPES : GOOGLE_DRIVE_SCOPES,
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
      const authedUser =
        payload.authed_user && typeof payload.authed_user === 'object'
          ? (payload.authed_user as Record<string, unknown>)
          : payload;
      return {
        accessToken: String(authedUser.access_token || ''),
        refreshToken:
          typeof authedUser.refresh_token === 'string' && authedUser.refresh_token.trim()
            ? authedUser.refresh_token
            : undefined,
        expiresAt:
          typeof authedUser.expires_in === 'number'
            ? Date.now() + Number(authedUser.expires_in) * 1000
            : null,
        tokenType: typeof payload.token_type === 'string' ? payload.token_type : undefined,
        scope:
          typeof authedUser.scope === 'string'
            ? authedUser.scope
                .split(/[ ,]+/)
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined,
      };
    }
    return {
      accessToken: String(payload.access_token || ''),
      refreshToken:
        typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
          ? payload.refresh_token
          : undefined,
      expiresAt:
        typeof payload.expires_in === 'number'
          ? Date.now() + Number(payload.expires_in) * 1000
          : null,
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
    const slackAuthedUser =
      connectorId === 'slack' && payload.authed_user && typeof payload.authed_user === 'object'
        ? (payload.authed_user as Record<string, unknown>)
        : null;
    const accessToken = String(
      connectorId === 'slack' ? slackAuthedUser?.access_token || '' : payload.access_token || ''
    );
    if (!accessToken) {
      throw new Error(`${connectorId} OAuth response did not include an access token`);
    }
    const baseRecord: ConnectorTokenRecord = {
      connectorId,
      accessToken,
      refreshToken:
        typeof (connectorId === 'slack'
          ? slackAuthedUser?.refresh_token
          : payload.refresh_token) === 'string' &&
        String(
          connectorId === 'slack' ? slackAuthedUser?.refresh_token : payload.refresh_token
        ).trim()
          ? String(connectorId === 'slack' ? slackAuthedUser?.refresh_token : payload.refresh_token)
          : undefined,
      expiresAt:
        typeof (connectorId === 'slack' ? slackAuthedUser?.expires_in : payload.expires_in) ===
        'number'
          ? Date.now() +
            Number(connectorId === 'slack' ? slackAuthedUser?.expires_in : payload.expires_in) *
              1000
          : null,
      tokenType: typeof payload.token_type === 'string' ? payload.token_type : undefined,
      scope: this.extractScopes(
        connectorId === 'slack' && slackAuthedUser ? slackAuthedUser : payload
      ),
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

    if (connectorId === 'gmail') {
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

    const about = await this.fetchDriveAbout(accessToken);
    const record: ConnectorTokenRecord = {
      ...baseRecord,
      accountEmail: about.emailAddress,
      accountId: about.permissionId,
      accountName: about.displayName,
    };
    this.assertRecordAllowed(record);
    return record;
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

  private async fetchDriveAbout(accessToken: string): Promise<{
    displayName: string | null;
    emailAddress: string | null;
    permissionId: string | null;
  }> {
    const payload = await this.fetchJson(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId)',
      accessToken
    );
    const user =
      payload.user && typeof payload.user === 'object'
        ? (payload.user as {
            displayName?: string;
            emailAddress?: string;
            permissionId?: string;
          })
        : {};
    return {
      displayName: typeof user.displayName === 'string' ? user.displayName : null,
      emailAddress: typeof user.emailAddress === 'string' ? user.emailAddress : null,
      permissionId: typeof user.permissionId === 'string' ? user.permissionId : null,
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
    const label = record.connectorId === 'gmail' ? 'Gmail' : 'Google Drive';
    assertAllowedGoogleConnectorEmail(record.accountEmail, label);
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
