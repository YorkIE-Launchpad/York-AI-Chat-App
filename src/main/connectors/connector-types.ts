export type ConnectorId = 'slack' | 'gmail' | 'google-drive' | 'zoom';

export interface ConnectorTokenRecord {
  connectorId: ConnectorId;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number | null;
  scope: string[];
  tokenType?: string;
  accountEmail?: string | null;
  accountName?: string | null;
  accountId?: string | null;
  workspaceName?: string | null;
  /** Slack team_id when known. */
  workspaceId?: string | null;
  /** Slack workspace URL from auth.test when known. */
  workspaceUrl?: string | null;
  updatedAt: number;
}

export interface ConnectorStatus {
  connectorId: ConnectorId;
  connected: boolean;
  accountEmail?: string | null;
  accountName?: string | null;
  workspaceName?: string | null;
}

export interface ConnectorOauthConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export interface ConnectorTokenRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number | null;
  tokenType?: string;
  scope?: string[];
}
