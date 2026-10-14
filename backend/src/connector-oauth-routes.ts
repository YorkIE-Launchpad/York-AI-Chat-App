import express, { type Request, type Response } from 'express';
import { logError } from './safe-log.js';

export type ConnectorOauthProvider = 'slack' | 'google' | 'zoom';

interface ConnectorOauthClient {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

type FetchFn = typeof fetch;

const TOKEN_URLS: Record<ConnectorOauthProvider, string> = {
  slack: 'https://slack.com/api/oauth.v2.access',
  google: 'https://oauth2.googleapis.com/token',
  zoom: 'https://zoom.us/oauth/token',
};

/** Only these fields are forwarded; client_id / client_secret always come from server env. */
const FORWARDED_FIELDS: Record<'authorization_code' | 'refresh_token', readonly string[]> = {
  authorization_code: ['code', 'redirect_uri', 'code_verifier'],
  refresh_token: ['refresh_token'],
};

function readEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

export function resolveConnectorOauthClient(
  provider: ConnectorOauthProvider
): ConnectorOauthClient | null {
  const [clientId, clientSecret] =
    provider === 'slack'
      ? [readEnv('SLACK_CLIENT_ID'), readEnv('SLACK_CLIENT_SECRET')]
      : provider === 'google'
        ? [
            readEnv('GOOGLE_CONNECTOR_CLIENT_ID', 'GOOGLE_CLIENT_ID'),
            readEnv('GOOGLE_CONNECTOR_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'),
          ]
        : [readEnv('ZOOM_CONNECTOR_CLIENT_ID'), readEnv('ZOOM_CONNECTOR_CLIENT_SECRET')];
  if (!clientId || !clientSecret) return null;
  return { tokenUrl: TOKEN_URLS[provider], clientId, clientSecret };
}

function isProvider(value: string): value is ConnectorOauthProvider {
  return value === 'slack' || value === 'google' || value === 'zoom';
}

export function buildConnectorTokenParams(
  body: unknown,
  client: ConnectorOauthClient
): URLSearchParams | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'JSON body required' };
  }
  const record = body as Record<string, unknown>;
  const grantType = record.grant_type;
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return { error: 'grant_type must be authorization_code or refresh_token' };
  }
  const params = new URLSearchParams({ grant_type: grantType });
  for (const field of FORWARDED_FIELDS[grantType]) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      params.set(field, value);
    }
  }
  const required = grantType === 'authorization_code' ? 'code' : 'refresh_token';
  if (!params.has(required)) {
    return { error: `${required} is required` };
  }
  params.set('client_id', client.clientId);
  params.set('client_secret', client.clientSecret);
  return params;
}

/**
 * Connector OAuth token exchange / refresh. Client secrets stay on the backend so
 * the desktop app never ships them. Mount after `requireCognito`.
 */
export function createConnectorOauthRouter(fetchFn: FetchFn = fetch): express.Router {
  const router = express.Router();

  router.post('/:provider/token', async (req: Request, res: Response) => {
    const provider = String(req.params.provider || '');
    if (!isProvider(provider)) {
      res.status(404).json({ error: 'unknown_connector' });
      return;
    }
    const client = resolveConnectorOauthClient(provider);
    if (!client) {
      res.status(503).json({ error: 'connector_oauth_not_configured' });
      return;
    }
    const params = buildConnectorTokenParams(req.body, client);
    if (!(params instanceof URLSearchParams)) {
      res.status(400).json({ error: params.error });
      return;
    }

    try {
      const upstream = await fetchFn(client.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') || 'application/json')
        .send(text);
    } catch (err) {
      logError(`[connector-oauth] ${provider} token request failed:`, err);
      res.status(502).json({ error: 'token_endpoint_unreachable' });
    }
  });

  return router;
}
