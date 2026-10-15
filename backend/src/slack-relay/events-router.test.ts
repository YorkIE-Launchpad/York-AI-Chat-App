import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import express from 'express';
import { resolveSlackRelayConfig } from './config.js';
import { createSlackEventsRouter, toInboundMessage } from './events-router.js';
import { SlackRelayHub } from './relay-hub.js';
import { createFakePeer, createFakeSlackApi } from './test-helpers.js';

const config = resolveSlackRelayConfig({
  SLACK_RELAY_ENABLED: 'true',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'secret',
  SLACK_APP_ID: 'A1',
  SLACK_ALLOWED_TEAM_ID: 'T1',
})!;

function eventBody(overrides: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    api_app_id: 'A1',
    team_id: 'T1',
    event_id: `Ev${Math.random()}`,
    event: {
      type: 'message',
      channel_type: 'im',
      user: 'U1',
      channel: 'D1',
      text: 'hi',
      ts: '1.0',
      ...event,
    },
    ...overrides,
  };
}

async function withServer(
  deps: Parameters<typeof createSlackEventsRouter>[0],
  fn: (post: (body: string, headers?: Record<string, string>) => Promise<Response>) => Promise<void>
) {
  const app = express();
  app.use('/slack', createSlackEventsRouter(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn((body, headers = {}) =>
      fetch(`http://127.0.0.1:${port}/slack/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      })
    );
  } finally {
    server.close();
  }
}

function signedHeaders(body: string, secret = 'secret'): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${sig}` };
}

describe('toInboundMessage', () => {
  it('accepts only human plain-text IMs for the pinned app and team', () => {
    assert.ok(toInboundMessage(eventBody(), config));
    assert.equal(toInboundMessage(eventBody({ api_app_id: 'A2' }), config), null);
    assert.equal(toInboundMessage(eventBody({ team_id: 'T2' }), config), null);
    assert.equal(
      toInboundMessage(eventBody({}, { channel_type: 'channel', channel: 'C1' }), config),
      null
    );
    assert.equal(toInboundMessage(eventBody({}, { subtype: 'message_changed' }), config), null);
    assert.equal(toInboundMessage(eventBody({}, { bot_id: 'B1' }), config), null);
    assert.equal(toInboundMessage(eventBody({}, { text: '   ' }), config), null);
    assert.equal(
      toInboundMessage(eventBody({}, { subtype: 'file_share', text: '', files: [] }), config),
      null
    );
  });

  it('accepts file shares, with or without text', () => {
    const file = { id: 'F1', mimetype: 'image/png' };
    const withText = toInboundMessage(
      eventBody({}, { subtype: 'file_share', text: 'what is this?', files: [file] }),
      config
    );
    assert.equal(withText?.text, 'what is this?');
    assert.deepEqual(withText?.files, [file]);

    const imageOnly = toInboundMessage(
      eventBody({}, { subtype: 'file_share', text: '', files: [file, 'junk'] }),
      config
    );
    assert.equal(imageOnly?.text, '');
    assert.deepEqual(imageOnly?.files, [file]);

    const many = Array.from({ length: 15 }, (_, i) => ({ id: `F${i}` }));
    const capped = toInboundMessage(eventBody({}, { subtype: 'file_share', files: many }), config);
    assert.equal(capped?.files?.length, 10);
  });
});

describe('POST /slack/events', () => {
  it('returns 503 when the relay is not configured', async () => {
    await withServer({ config: null, hub: null }, async (post) => {
      const res = await post('{}');
      assert.equal(res.status, 503);
    });
  });

  it('rejects unsigned and wrongly signed requests', async () => {
    const hub = new SlackRelayHub(createFakeSlackApi());
    await withServer({ config, hub }, async (post) => {
      const body = JSON.stringify({ type: 'url_verification', challenge: 'c' });
      assert.equal((await post(body)).status, 401);
      assert.equal((await post(body, signedHeaders(body, 'wrong'))).status, 401);
    });
  });

  it('answers url_verification only when signed', async () => {
    const hub = new SlackRelayHub(createFakeSlackApi());
    await withServer({ config, hub }, async (post) => {
      const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
      const res = await post(body, signedHeaders(body));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { challenge: 'abc' });
    });
  });

  it('routes signed DMs to the owner and ignores Slack retries', async () => {
    const hub = new SlackRelayHub(createFakeSlackApi());
    const peer = createFakePeer('p1');
    hub.registerOwner('T1:U1', peer, 'D1');
    await withServer({ config, hub }, async (post) => {
      const body = JSON.stringify(eventBody());
      assert.equal((await post(body, signedHeaders(body))).status, 200);
      const retry = JSON.stringify(eventBody());
      assert.equal(
        (await post(retry, { ...signedHeaders(retry), 'x-slack-retry-num': '1' })).status,
        200
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(peer.frames.length, 1);
    });
  });

  it('rejects bodies over the size limit', async () => {
    const hub = new SlackRelayHub(createFakeSlackApi());
    await withServer({ config, hub }, async (post) => {
      const body = JSON.stringify({ pad: 'x'.repeat(260 * 1024) });
      assert.equal((await post(body, signedHeaders(body))).status, 413);
    });
  });
});
