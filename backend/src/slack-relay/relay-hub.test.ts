import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RELAY_CLOSE_CODES,
  RELAY_LIMITS,
  SlackRelayHub,
  type InboundSlackMessage,
} from './relay-hub.js';
import { createFakePeer, createFakeSlackApi } from './test-helpers.js';

let eventCounter = 0;
function inbound(overrides: Partial<InboundSlackMessage> = {}): InboundSlackMessage {
  eventCounter += 1;
  return {
    eventId: `Ev${eventCounter}`,
    teamId: 'T1',
    userId: 'U1',
    channel: 'D1',
    text: 'hello',
    ts: '1.0',
    ...overrides,
  };
}

function setup(now = () => Date.now()) {
  const api = createFakeSlackApi();
  const hub = new SlackRelayHub(api, { now });
  const peer = createFakePeer('p1');
  hub.registerOwner('T1:U1', peer, 'D1');
  return { api, hub, peer };
}

function lastHandle(peer: ReturnType<typeof createFakePeer>): string {
  const frame = peer.frames.at(-1);
  assert.equal(frame?.type, 'event');
  return frame!.replyHandle as string;
}

describe('SlackRelayHub routing', () => {
  it('delivers only to the sender’s own desktop, without exposing the channel id', async () => {
    const { hub, peer } = setup();
    const other = createFakePeer('p2');
    hub.registerOwner('T1:U2', other, 'D2');

    assert.equal(await hub.handleInbound(inbound()), 'delivered');
    assert.equal(peer.frames.length, 1);
    assert.equal(other.frames.length, 0);
    assert.equal(peer.frames[0].channel, undefined);
    assert.equal(typeof peer.frames[0].replyHandle, 'string');
  });

  it('drops events posted outside the owner IM', async () => {
    const { hub, peer } = setup();
    assert.equal(await hub.handleInbound(inbound({ channel: 'D999' })), 'dropped');
    assert.equal(peer.frames.length, 0);
  });

  it('dedupes replayed event ids', async () => {
    const { hub, peer } = setup();
    const msg = inbound();
    assert.equal(await hub.handleInbound(msg), 'delivered');
    assert.equal(await hub.handleInbound(msg), 'dropped');
    assert.equal(peer.frames.length, 1);
  });

  it('rate limits inbound per user', async () => {
    const { hub } = setup();
    for (let i = 0; i < RELAY_LIMITS.inboundPerUserPerMinute; i++) {
      assert.equal(await hub.handleInbound(inbound()), 'delivered');
    }
    assert.equal(await hub.handleInbound(inbound()), 'dropped');
  });

  it('sends a throttled offline notice when no desktop is connected', async () => {
    const api = createFakeSlackApi();
    const hub = new SlackRelayHub(api);
    assert.equal(await hub.handleInbound(inbound()), 'offline');
    assert.equal(await hub.handleInbound(inbound()), 'offline');
    assert.equal(api.posts.length, 1);
  });

  it('closes and alerts on takeover by a new desktop', async () => {
    const { api, hub, peer } = setup();
    const next = createFakePeer('p-new');
    assert.deepEqual(hub.registerOwner('T1:U1', next, 'D1'), { replaced: true });
    assert.equal(peer.closed?.code, RELAY_CLOSE_CODES.replaced);
    await hub.drain();
    assert.equal(api.posts.length, 1);
    assert.equal(api.posts[0].channel, 'D1');
  });
});

describe('SlackRelayHub replies', () => {
  it('posts sanitized text to the owner IM via a valid handle', async () => {
    const { api, hub, peer } = setup();
    await hub.handleInbound(inbound({ threadTs: '9.9' }));
    const result = await hub.handleReply(peer, lastHandle(peer), '<!channel> hi');
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(api.posts, [{ channel: 'D1', text: '&lt;!channel&gt; hi', threadTs: '9.9' }]);
  });

  it('rejects unknown, foreign, and expired handles', async () => {
    let now = 1_000_000;
    const { api, hub, peer } = setup(() => now);
    await hub.handleInbound(inbound());
    const handle = lastHandle(peer);

    assert.deepEqual(await hub.handleReply(peer, 'forged', 'x'), {
      ok: false,
      error: 'unknown_handle',
    });
    assert.deepEqual(await hub.handleReply(createFakePeer('intruder'), handle, 'x'), {
      ok: false,
      error: 'unknown_handle',
    });
    now += RELAY_LIMITS.replyHandleTtlMs + 1;
    assert.deepEqual(await hub.handleReply(peer, handle, 'x'), {
      ok: false,
      error: 'unknown_handle',
    });
    assert.equal(api.posts.length, 0);
  });

  it('revokes handles when the desktop disconnects or is replaced', async () => {
    const { hub, peer } = setup();
    await hub.handleInbound(inbound());
    const handle = lastHandle(peer);
    hub.unregisterPeer(peer);
    hub.registerOwner('T1:U1', peer, 'D1');
    assert.deepEqual(await hub.handleReply(peer, handle, 'x'), {
      ok: false,
      error: 'unknown_handle',
    });
  });

  it('rejects oversized and empty replies', async () => {
    const { hub, peer } = setup();
    await hub.handleInbound(inbound());
    const handle = lastHandle(peer);
    assert.deepEqual(await hub.handleReply(peer, handle, ' '), { ok: false, error: 'invalid' });
    assert.deepEqual(
      await hub.handleReply(peer, handle, 'x'.repeat(RELAY_LIMITS.replyTextMax + 1)),
      {
        ok: false,
        error: 'too_large',
      }
    );
  });

  it('caps total chunks per handle', async () => {
    const { hub, peer } = setup();
    await hub.handleInbound(inbound());
    const handle = lastHandle(peer);
    const big = 'y'.repeat(RELAY_LIMITS.replyChunkLength * 10);
    for (let i = 0; i < RELAY_LIMITS.replyHandleMaxChunks / 10; i++) {
      assert.deepEqual(await hub.handleReply(peer, handle, big), { ok: true });
    }
    assert.deepEqual(await hub.handleReply(peer, handle, 'z'), {
      ok: false,
      error: 'handle_exhausted',
    });
  });
});
