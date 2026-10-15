import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { YORK_APP_VERSION_HEADER } from '../client-version.js';
import { resolveSlackRelayConfig } from './config.js';
import { RELAY_CLOSE_CODES, SlackRelayHub } from './relay-hub.js';
import { attachSlackRelay, SLACK_RELAY_WS_PATH } from './relay-ws.js';
import { createFakeSlackApi, type FakeSlackApi } from './test-helpers.js';

const config = resolveSlackRelayConfig({
  SLACK_RELAY_ENABLED: 'true',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'secret',
  SLACK_APP_ID: 'A1',
  SLACK_ALLOWED_TEAM_ID: 'T1',
})!;

const SLACK_USER_TOKEN = 'xoxp-1234567890-abcdef';

type Claims = Record<string, unknown>;
function idClaims(overrides: Claims = {}): Claims {
  return {
    sub: 'sub-1',
    email: 'dev@york.ie',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function startRelay(opts: {
  claims?: Claims;
  tokenUse?: 'id' | 'access';
  api?: FakeSlackApi;
  disabled?: boolean;
}) {
  const api = opts.api ?? createFakeSlackApi();
  const hub = new SlackRelayHub(api);
  const server = createServer();
  servers.push(server);
  attachSlackRelay(server, {
    config: opts.disabled ? null : config,
    hub: opts.disabled ? null : hub,
    api: opts.disabled ? null : api,
    verifyToken: async (token) =>
      token === 'good-jwt'
        ? { ok: true, payload: opts.claims ?? idClaims(), tokenUse: opts.tokenUse ?? 'id' }
        : { ok: false, error: 'bad' },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { api, hub, url: `ws://127.0.0.1:${port}${SLACK_RELAY_WS_PATH}` };
}

function defaultHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer good-jwt', [YORK_APP_VERSION_HEADER]: '99.0.0', ...extra };
}

/** Resolves with the HTTP status for rejected upgrades, or 101 when the socket opens. */
function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode || 0);
      res.resume();
    });
    ws.on('open', () => {
      resolve(101);
      ws.close();
    });
    ws.on('error', () => resolve(0));
  });
}

function connect(url: string) {
  const ws = new WebSocket(url, { headers: defaultHeaders() });
  const frames: Array<Record<string, unknown>> = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const nextFrame = async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const found = frames.find((f) => f.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${type}`);
  };
  return { ws, frames, closed, opened, nextFrame };
}

describe('slack relay upgrade gate', () => {
  it('refuses upgrades when the relay is disabled', async () => {
    const { url } = await startRelay({ disabled: true });
    assert.equal(await upgradeStatus(url, defaultHeaders()), 503);
  });

  it('requires a bearer token in the Authorization header, not the URL', async () => {
    const { url } = await startRelay({});
    assert.equal(await upgradeStatus(url, { [YORK_APP_VERSION_HEADER]: '99.0.0' }), 401);
    assert.equal(await upgradeStatus(`${url}?token=good-jwt`, defaultHeaders()), 400);
    assert.equal(await upgradeStatus(url, defaultHeaders({ Authorization: 'Bearer nope' })), 401);
  });

  it('rejects browser origins and outdated clients', async () => {
    const { url } = await startRelay({});
    assert.equal(await upgradeStatus(url, defaultHeaders({ Origin: 'https://evil.example' })), 403);
    assert.equal(
      await upgradeStatus(url, defaultHeaders({ [YORK_APP_VERSION_HEADER]: '0.0.1' })),
      426
    );
  });

  it('requires a Cognito id token with a verified allowed email', async () => {
    assert.equal(
      await upgradeStatus((await startRelay({ tokenUse: 'access' })).url, defaultHeaders()),
      401
    );
    const unverified = await startRelay({ claims: idClaims({ email_verified: false }) });
    assert.equal(await upgradeStatus(unverified.url, defaultHeaders()), 403);
    const foreign = await startRelay({ claims: idClaims({ email: 'x@evil.com' }) });
    assert.equal(await upgradeStatus(foreign.url, defaultHeaders()), 403);
  });
});

describe('slack relay registration', () => {
  it('registers when the Slack identity matches, then relays replies end to end', async () => {
    const { api, hub, url } = await startRelay({});
    const client = connect(url);
    await client.opened;
    client.ws.send(JSON.stringify({ type: 'register', slackUserToken: SLACK_USER_TOKEN }));
    const registered = await client.nextFrame('registered');
    assert.equal(registered.slackUserId, 'U1');

    await hub.handleInbound({
      eventId: 'E1',
      teamId: 'T1',
      userId: 'U1',
      channel: 'D1',
      text: 'hi',
      ts: '1.0',
    });
    const event = await client.nextFrame('event');
    client.ws.send(
      JSON.stringify({
        type: 'reply',
        replyHandle: event.replyHandle,
        text: 'done',
        requestId: 'r1',
      })
    );
    const result = await client.nextFrame('reply_result');
    assert.equal(result.ok, true);
    assert.deepEqual(api.posts.at(-1), { channel: 'D1', text: 'done', threadTs: undefined });
    client.ws.close();
  });

  it('rejects when the Slack email does not match the Cognito email', async () => {
    const api = createFakeSlackApi();
    api.profile = { ...api.profile, email: 'someone-else@york.ie' };
    const { url } = await startRelay({ api });
    const client = connect(url);
    await client.opened;
    client.ws.send(JSON.stringify({ type: 'register', slackUserToken: SLACK_USER_TOKEN }));
    assert.equal((await client.closed).code, RELAY_CLOSE_CODES.forbidden);
  });

  it('rejects guests and foreign workspaces', async () => {
    const guestApi = createFakeSlackApi();
    guestApi.profile = { ...guestApi.profile, isRestricted: true };
    const guest = connect((await startRelay({ api: guestApi })).url);
    await guest.opened;
    guest.ws.send(JSON.stringify({ type: 'register', slackUserToken: SLACK_USER_TOKEN }));
    assert.equal((await guest.closed).code, RELAY_CLOSE_CODES.forbidden);

    const foreignApi = createFakeSlackApi();
    foreignApi.identity = { userId: 'U1', teamId: 'T-other' };
    const foreign = connect((await startRelay({ api: foreignApi })).url);
    await foreign.opened;
    foreign.ws.send(JSON.stringify({ type: 'register', slackUserToken: SLACK_USER_TOKEN }));
    assert.equal((await foreign.closed).code, RELAY_CLOSE_CODES.forbidden);
  });

  it('rejects malformed tokens and any frame before register', async () => {
    const { url } = await startRelay({});
    const bad = connect(url);
    await bad.opened;
    bad.ws.send(JSON.stringify({ type: 'register', slackUserToken: 'xoxb-bot-token-not-allowed' }));
    assert.equal((await bad.closed).code, RELAY_CLOSE_CODES.forbidden);

    const early = connect(url);
    await early.opened;
    early.ws.send(JSON.stringify({ type: 'reply', replyHandle: 'x', text: 'y' }));
    assert.equal((await early.closed).code, RELAY_CLOSE_CODES.unauthorized);
  });

  it('closes the socket when the Cognito token expires', async () => {
    const { url } = await startRelay({
      claims: idClaims({ exp: Math.floor(Date.now() / 1000) + 1 }),
    });
    const client = connect(url);
    await client.opened;
    client.ws.send(JSON.stringify({ type: 'register', slackUserToken: SLACK_USER_TOKEN }));
    const closed = await client.closed;
    assert.equal(closed.code, RELAY_CLOSE_CODES.unauthorized);
    assert.equal(closed.reason, 'token_expired');
  });
});
