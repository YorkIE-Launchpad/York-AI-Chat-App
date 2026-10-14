import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { buildConnectorTokenParams, createConnectorOauthRouter } from './connector-oauth-routes.js';

const client = {
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  clientId: 'server-id',
  clientSecret: 'server-secret',
};

describe('buildConnectorTokenParams', () => {
  it('adds server client credentials to an authorization_code exchange', () => {
    const params = buildConnectorTokenParams(
      { grant_type: 'authorization_code', code: 'c1', redirect_uri: 'r', code_verifier: 'v' },
      client
    );
    assert.ok(params instanceof URLSearchParams);
    assert.equal(params.get('code'), 'c1');
    assert.equal(params.get('redirect_uri'), 'r');
    assert.equal(params.get('code_verifier'), 'v');
    assert.equal(params.get('client_id'), 'server-id');
    assert.equal(params.get('client_secret'), 'server-secret');
  });

  it('ignores client-supplied client_id / client_secret and unknown fields', () => {
    const params = buildConnectorTokenParams(
      {
        grant_type: 'refresh_token',
        refresh_token: 'rt',
        client_id: 'evil',
        client_secret: 'evil',
        code: 'not-forwarded-for-refresh',
      },
      client
    );
    assert.ok(params instanceof URLSearchParams);
    assert.equal(params.get('client_id'), 'server-id');
    assert.equal(params.get('client_secret'), 'server-secret');
    assert.equal(params.has('code'), false);
  });

  it('rejects unsupported grant types and missing required fields', () => {
    assert.deepEqual(buildConnectorTokenParams({ grant_type: 'client_credentials' }, client), {
      error: 'grant_type must be authorization_code or refresh_token',
    });
    assert.deepEqual(buildConnectorTokenParams({ grant_type: 'authorization_code' }, client), {
      error: 'code is required',
    });
  });
});

describe('connector OAuth router', () => {
  const prevEnv = { ...process.env };
  let server: http.Server;
  let port = 0;
  let lastCall: { url: string; body: string } | null = null;

  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    lastCall = { url: String(url), body: String(init?.body ?? '') };
    return new Response(JSON.stringify({ ok: true, access_token: 'xoxp-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  before(async () => {
    const app = express();
    app.use('/connectors/oauth', express.json(), createConnectorOauthRouter(fakeFetch));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  after(async () => {
    process.env = prevEnv;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    lastCall = null;
    process.env.SLACK_CLIENT_ID = 'slack-id';
    process.env.SLACK_CLIENT_SECRET = 'slack-secret';
  });

  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/connectors/oauth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('forwards to the provider with server-held credentials', async () => {
    const res = await post('/slack/token', { grant_type: 'authorization_code', code: 'abc' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, access_token: 'xoxp-1' });
    assert.equal(lastCall?.url, 'https://slack.com/api/oauth.v2.access');
    const sent = new URLSearchParams(lastCall?.body);
    assert.equal(sent.get('client_secret'), 'slack-secret');
    assert.equal(sent.get('client_id'), 'slack-id');
  });

  it('returns 404 for unknown connectors', async () => {
    const res = await post('/github/token', { grant_type: 'authorization_code', code: 'abc' });
    assert.equal(res.status, 404);
    assert.equal(lastCall, null);
  });

  it('returns 503 when the server has no credentials for the connector', async () => {
    delete process.env.SLACK_CLIENT_SECRET;
    const res = await post('/slack/token', { grant_type: 'authorization_code', code: 'abc' });
    assert.equal(res.status, 503);
    assert.equal(lastCall, null);
  });
});
