import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it, mock } from 'node:test';
import express, { type Router } from 'express';
import {
  ACTION_IDS,
  renderApprovalCard,
  renderChatList,
  renderFinishedStatus,
  renderWorkingStatus,
} from './blocks.js';
import { parseSlashText, createSlackCommandsRouter } from './commands-router.js';
import { resolveSlackRelayConfig } from './config.js';
import { createSlackInteractionsRouter, toBlockAction } from './interactions-router.js';
import { RELAY_LIMITS, SlackRelayHub, type InboundSlackMessage } from './relay-hub.js';
import { createFakePeer, createFakeSlackApi, flushAsync, type FakePeer } from './test-helpers.js';

const config = resolveSlackRelayConfig({
  SLACK_RELAY_ENABLED: 'true',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'secret',
  SLACK_APP_ID: 'A1',
  SLACK_ALLOWED_TEAM_ID: 'T1',
})!;

const CAPS = ['status', 'approvals', 'commands'];
const APPROVAL_ID = 'appr_'.padEnd(24, 'x');
const CHAT_TOKEN = 'chat_'.padEnd(24, 'y');

let eventCounter = 0;
function inbound(overrides: Partial<InboundSlackMessage> = {}): InboundSlackMessage {
  eventCounter += 1;
  return {
    eventId: `EvI${eventCounter}`,
    teamId: 'T1',
    userId: 'U1',
    channel: 'D1',
    text: 'hello',
    ts: '5.0',
    ...overrides,
  };
}

function setup(capabilities: string[] = CAPS) {
  const api = createFakeSlackApi();
  const hub = new SlackRelayHub(api);
  const peer = createFakePeer('p1');
  hub.registerOwner('T1:U1', peer, 'D1', capabilities);
  return { api, hub, peer };
}

async function handleFor(hub: SlackRelayHub, peer: FakePeer): Promise<string> {
  assert.equal(await hub.handleInbound(inbound()), 'delivered');
  const frame = peer.frames.at(-1)!;
  assert.equal(frame.type, 'event');
  return frame.replyHandle as string;
}

function approvalFrame(replyHandle: string, overrides: Record<string, unknown> = {}) {
  return {
    replyHandle,
    approvalId: APPROVAL_ID,
    toolName: 'Bash',
    summary: 'Command: npm test',
    expiresInSec: 120,
    ...overrides,
  };
}

const click = (overrides: Record<string, string> = {}) => ({
  teamId: 'T1',
  userId: 'U1',
  channelId: 'D1',
  approvalId: APPROVAL_ID,
  decision: 'allow' as const,
  ...overrides,
});

afterEach(() => {
  mock.timers.reset();
});

describe('block renderers', () => {
  it('escapes desktop text in status, approval and chat list blocks', () => {
    const status = JSON.stringify(renderWorkingStatus('<!channel> & co').blocks);
    assert.ok(status.includes('&lt;!channel&gt; &amp; co'));

    const card = JSON.stringify(
      renderApprovalCard({
        approvalId: APPROVAL_ID,
        toolName: 'Bash',
        summary: '<@U2>',
        state: 'pending',
        expiresInSec: 60,
      }).blocks
    );
    assert.ok(card.includes('&lt;@U2&gt;'));
    assert.ok(card.includes(ACTION_IDS.approvalAllow) && card.includes(ACTION_IDS.approvalDeny));

    const list = JSON.stringify(
      renderChatList([{ token: CHAT_TOKEN, title: '<!here>', updatedLabel: 'now', current: false }])
        .blocks
    );
    assert.ok(list.includes('&lt;!here&gt;'));
    assert.ok(list.includes(ACTION_IDS.chatOpen) && list.includes(ACTION_IDS.chatNew));
  });

  it('removes buttons once an approval is no longer pending', () => {
    for (const state of ['allowing', 'denying', 'allowed', 'denied', 'expired'] as const) {
      const blocks = renderApprovalCard({
        approvalId: APPROVAL_ID,
        toolName: 'Bash',
        summary: 's',
        state,
        expiresInSec: 60,
      }).blocks;
      assert.equal(
        blocks.some((b) => b.type === 'actions'),
        false,
        state
      );
    }
  });

  it('summarizes finished turns', () => {
    assert.equal(
      renderFinishedStatus({ outcome: 'done', elapsedMs: 12_000, steps: 3 }).text,
      'Done in 12s  ·  3 steps'
    );
    assert.equal(
      renderFinishedStatus({ outcome: 'done', elapsedMs: 500, steps: 0 }).text,
      'Done in 1s'
    );
    assert.match(
      renderFinishedStatus({ outcome: 'error', elapsedMs: 61_000, steps: 0 }).text,
      /1m 1s/
    );
  });
});

describe('SlackRelayHub status', () => {
  it('reacts, posts a working message, and finishes with a summary and reaction swap', async () => {
    const { api, hub, peer } = setup();
    const handle = await handleFor(hub, peer);

    assert.ok(hub.handleStatus(peer, handle, 'start'));
    await hub.drain();
    assert.deepEqual(api.reactions, [
      { op: 'add', channel: 'D1', ts: '5.0', name: 'hourglass_flowing_sand' },
    ]);
    assert.equal(api.posts.length, 1);
    assert.match(api.posts[0].text, /Working on it/);

    assert.ok(hub.handleStatus(peer, handle, 'done', undefined, 2));
    await hub.drain();
    assert.equal(api.updates.length, 1);
    assert.equal(api.updates[0].ts, '100.1');
    assert.match(api.updates[0].text, /Done in .* 2 steps/);
    assert.deepEqual(api.reactions.slice(1), [
      { op: 'remove', channel: 'D1', ts: '5.0', name: 'hourglass_flowing_sand' },
      { op: 'add', channel: 'D1', ts: '5.0', name: 'white_check_mark' },
    ]);
  });

  it('marks errors with an x reaction', async () => {
    const { api, hub, peer } = setup();
    const handle = await handleFor(hub, peer);
    hub.handleStatus(peer, handle, 'start');
    hub.handleStatus(peer, handle, 'error');
    await hub.drain();
    assert.equal(api.reactions.at(-1)?.name, 'x');
  });

  it('ignores done without a prior start, and handles from another peer', async () => {
    const { api, hub, peer } = setup();
    const handle = await handleFor(hub, peer);
    assert.ok(hub.handleStatus(peer, handle, 'done'));
    assert.equal(hub.handleStatus(createFakePeer('intruder'), handle, 'start'), false);
    await hub.drain();
    assert.equal(api.posts.length, 0);
    assert.equal(api.reactions.length, 0);
  });

  it('coalesces rapid step labels into one update per interval', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { api, hub, peer } = setup();
    const handle = await handleFor(hub, peer);
    hub.handleStatus(peer, handle, 'start');
    await hub.drain();

    for (const label of ['Reading files', 'Running a command', 'Editing files']) {
      hub.handleStatus(peer, handle, 'step', label);
    }
    await hub.drain();
    assert.equal(api.updates.length, 0);

    mock.timers.tick(RELAY_LIMITS.statusUpdateIntervalMs);
    await flushAsync();
    await hub.drain();
    assert.equal(api.updates.length, 1);
    assert.match(api.updates[0].text, /Editing files/);
  });
});

describe('SlackRelayHub approvals', () => {
  it('posts a card and relays a single owner click to the desktop', async () => {
    const { api, hub, peer } = setup();
    const handle = await handleFor(hub, peer);
    assert.ok(hub.handleApproval(peer, approvalFrame(handle)));
    await hub.drain();
    assert.equal(api.posts.length, 1);
    assert.ok(JSON.stringify(api.posts[0].blocks).includes(ACTION_IDS.approvalAllow));

    assert.equal(hub.clickApproval(click()), 'ok');
    assert.deepEqual(peer.frames.at(-1), {
      type: 'action',
      kind: 'approval',
      approvalId: APPROVAL_ID,
      decision: 'allow',
    });
    assert.equal(hub.clickApproval(click({ decision: 'deny' })), 'unknown');

    assert.ok(hub.handleApprovalClosed(peer, APPROVAL_ID, 'allowed'));
    await hub.drain();
    assert.ok(JSON.stringify(api.updates.at(-1)?.blocks).includes('Allowed'));
    assert.equal(hub.clickApproval(click()), 'unknown');
  });

  it('rejects clicks from other users or channels and invalid frames', async () => {
    const { hub, peer } = setup();
    const handle = await handleFor(hub, peer);
    assert.equal(hub.handleApproval(peer, approvalFrame(handle, { approvalId: 'short' })), false);
    assert.equal(hub.handleApproval(peer, approvalFrame(handle, { expiresInSec: 1 })), false);
    assert.equal(hub.handleApproval(peer, approvalFrame(handle, { toolName: '' })), false);
    assert.ok(hub.handleApproval(peer, approvalFrame(handle)));
    assert.equal(hub.handleApproval(peer, approvalFrame(handle)), false);

    const before = peer.frames.length;
    assert.equal(hub.clickApproval(click({ userId: 'U2' })), 'unknown');
    assert.equal(hub.clickApproval(click({ channelId: 'D2' })), 'unknown');
    assert.equal(hub.clickApproval(click({ approvalId: 'z'.repeat(24) })), 'unknown');
    assert.equal(peer.frames.length, before);
  });

  it('expires stale approvals instead of relaying them', async () => {
    let now = 1_000_000;
    const api = createFakeSlackApi();
    const hub = new SlackRelayHub(api, { now: () => now });
    const peer = createFakePeer('p1');
    hub.registerOwner('T1:U1', peer, 'D1', CAPS);
    const handle = await handleFor(hub, peer);
    hub.handleApproval(peer, approvalFrame(handle, { expiresInSec: 10 }));
    now += 11_000;
    const before = peer.frames.length;
    assert.equal(hub.clickApproval(click()), 'expired');
    assert.equal(peer.frames.length, before);
  });
});

describe('SlackRelayHub commands', () => {
  it('reports offline and outdated desktops', () => {
    const api = createFakeSlackApi();
    const hub = new SlackRelayHub(api);
    assert.equal(hub.commandAvailability('T1', 'U1'), 'offline');
    hub.registerOwner('T1:U1', createFakePeer('old'), 'D1');
    assert.equal(hub.commandAvailability('T1', 'U1'), 'outdated');
    assert.equal(hub.dispatchCommand({ teamId: 'T1', userId: 'U1', name: 'new' }), 'outdated');
  });

  it('forwards commands with a fresh reply handle the desktop can answer on', async () => {
    const { api, hub, peer } = setup();
    assert.equal(
      hub.dispatchCommand({ teamId: 'T1', userId: 'U1', name: 'new', arg: 'draft a memo' }),
      'ok'
    );
    const frame = peer.frames.at(-1)!;
    assert.equal(frame.type, 'action');
    assert.equal(frame.name, 'new');
    assert.equal(frame.arg, 'draft a memo');
    assert.ok(hub.handleNotice(peer, frame.replyHandle, 'Started a new chat.'));
    await hub.drain();
    assert.deepEqual(api.posts.at(-1), { channel: 'D1', text: 'Started a new chat.' });
  });

  it('only opens chat tokens the desktop listed for this owner', async () => {
    const { api, hub, peer } = setup();
    assert.equal(
      hub.dispatchCommand({ teamId: 'T1', userId: 'U1', name: 'open', token: CHAT_TOKEN }),
      'unknown'
    );
    const handle = await handleFor(hub, peer);
    assert.ok(
      hub.handleChatList(peer, handle, [
        { token: CHAT_TOKEN, title: 'Budget', updatedLabel: '2h ago', current: false },
      ])
    );
    await hub.drain();
    assert.ok(JSON.stringify(api.posts.at(-1)?.blocks).includes(CHAT_TOKEN));
    assert.equal(
      hub.dispatchCommand({ teamId: 'T1', userId: 'U1', name: 'open', token: CHAT_TOKEN }),
      'ok'
    );
    assert.equal(peer.frames.at(-1)?.arg, CHAT_TOKEN);
    assert.equal(hub.handleChatList(peer, handle, [{ token: 'bad', title: 'x' }]), false);
  });
});

function signed(body: string, contentType: string, secret = 'secret') {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return {
    'content-type': contentType,
    'x-slack-request-timestamp': ts,
    'x-slack-signature': `v0=${sig}`,
  };
}

async function withRouter(
  router: Router,
  path: string,
  fn: (post: (body: string, headers: Record<string, string>) => Promise<Response>) => Promise<void>
) {
  const app = express();
  app.use('/slack', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn((body, headers) =>
      fetch(`http://127.0.0.1:${port}/slack${path}`, { method: 'POST', headers, body })
    );
  } finally {
    server.close();
  }
}

function interactionBody(
  overrides: Record<string, unknown> = {},
  action: Record<string, unknown> = {}
) {
  const payload = {
    type: 'block_actions',
    api_app_id: 'A1',
    team: { id: 'T1' },
    user: { id: 'U1', team_id: 'T1' },
    channel: { id: 'D1' },
    trigger_id: `trig-${Math.random()}`,
    response_url: 'https://hooks.slack.com/actions/T1/1/abc',
    actions: [{ action_id: ACTION_IDS.approvalAllow, value: APPROVAL_ID, action_ts: '1.1' }],
    ...overrides,
  };
  if (Object.keys(action).length) payload.actions = [{ ...payload.actions[0], ...action }];
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

const FORM = 'application/x-www-form-urlencoded';

describe('toBlockAction', () => {
  it('accepts only the pinned app and team, real users, and IM channels', () => {
    const parse = (overrides: Record<string, unknown>) =>
      toBlockAction(
        JSON.parse(new URLSearchParams(interactionBody(overrides)).get('payload')!),
        config
      );
    assert.ok(parse({}));
    assert.equal(parse({ api_app_id: 'A2' }), null);
    assert.equal(parse({ team: { id: 'T2' }, user: { id: 'U1', team_id: 'T2' } }), null);
    assert.equal(parse({ channel: { id: 'C1' } }), null);
    assert.equal(parse({ user: { id: 'B1' } }), null);
    assert.equal(parse({ type: 'view_submission' }), null);
  });
});

describe('POST /slack/interactions', () => {
  it('rejects bad signatures', async () => {
    const { api, hub } = setup();
    await withRouter(
      createSlackInteractionsRouter({ config, hub, api }),
      '/interactions',
      async (post) => {
        const body = interactionBody();
        const res = await post(body, signed(body, FORM, 'wrong'));
        assert.equal(res.status, 401);
      }
    );
  });

  it('acks before slow Slack calls finish, relays the click once, and dedupes retries', async () => {
    const { api, hub, peer } = setup();
    const handle = await handleFor(hub, peer);
    hub.handleApproval(peer, approvalFrame(handle));
    await hub.drain();

    let release!: () => void;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withRouter(
      createSlackInteractionsRouter({ config, hub, api }),
      '/interactions',
      async (post) => {
        const body = interactionBody({ trigger_id: 'trig-fixed' });
        const started = Date.now();
        const res = await post(body, signed(body, FORM));
        assert.equal(res.status, 200);
        assert.ok(Date.now() - started < 1_000);

        const retry = await post(body, signed(body, FORM));
        assert.equal(retry.status, 200);
        await flushAsync();

        const actions = peer.frames.filter((f) => f.type === 'action');
        assert.equal(actions.length, 1);
        assert.equal(actions[0].decision, 'allow');
      }
    );
    release();
    api.gate = null;
    await hub.drain();
  });

  it('tells someone else clicking the card that it is not theirs', async () => {
    const { api, hub, peer } = setup();
    const handle = await handleFor(hub, peer);
    hub.handleApproval(peer, approvalFrame(handle));
    await withRouter(
      createSlackInteractionsRouter({ config, hub, api }),
      '/interactions',
      async (post) => {
        const body = interactionBody({ user: { id: 'U2', team_id: 'T1' } });
        assert.equal((await post(body, signed(body, FORM))).status, 200);
        await flushAsync();
      }
    );
    assert.equal(peer.frames.filter((f) => f.type === 'action').length, 0);
    assert.match(String(api.responses.at(-1)?.body.text), /no longer active/);
  });

  it('opens and starts chats only from the owner IM', async () => {
    const { api, hub, peer } = setup();
    await withRouter(
      createSlackInteractionsRouter({ config, hub, api }),
      '/interactions',
      async (post) => {
        const elsewhere = interactionBody(
          { channel: { id: 'D9' } },
          { action_id: ACTION_IDS.chatNew, value: 'new' }
        );
        await post(elsewhere, signed(elsewhere, FORM));
        const mine = interactionBody({}, { action_id: ACTION_IDS.chatNew, value: 'new' });
        await post(mine, signed(mine, FORM));
        await flushAsync();
      }
    );
    const commands = peer.frames.filter((f) => f.type === 'action');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, 'new');
  });
});

describe('POST /slack/commands', () => {
  const commandBody = (fields: Record<string, string> = {}) =>
    new URLSearchParams({
      api_app_id: 'A1',
      team_id: 'T1',
      user_id: 'U1',
      channel_id: 'D1',
      command: '/growth',
      text: '',
      trigger_id: `trig-${Math.random()}`,
      response_url: 'https://hooks.slack.com/commands/T1/1/abc',
      ...fields,
    }).toString();

  it('parses subcommands and aliases', () => {
    assert.deepEqual(parseSlashText(''), { name: 'help', arg: '', raw: '' });
    assert.equal(parseSlashText('ls').name, 'chats');
    assert.equal(parseSlashText('Cancel').name, 'stop');
    assert.deepEqual(parseSlashText('new  write a poem'), {
      name: 'new',
      arg: 'write a poem',
      raw: 'new',
    });
    assert.equal(parseSlashText('dance').name, null);
  });

  it('rejects bad signatures and other workspaces', async () => {
    const { api, hub } = setup();
    await withRouter(createSlackCommandsRouter({ config, hub, api }), '/commands', async (post) => {
      const body = commandBody();
      assert.equal((await post(body, signed(body, FORM, 'wrong'))).status, 401);
      const foreign = commandBody({ team_id: 'T2' });
      assert.equal((await post(foreign, signed(foreign, FORM))).status, 403);
    });
  });

  it('answers help and unknown commands directly', async () => {
    const { api, hub, peer } = setup();
    await withRouter(createSlackCommandsRouter({ config, hub, api }), '/commands', async (post) => {
      const help = commandBody({ text: 'help' });
      const res = await post(help, signed(help, FORM));
      const json = (await res.json()) as Record<string, string>;
      assert.equal(json.response_type, 'ephemeral');
      assert.match(json.text, /\/growth new/);

      const renamed = commandBody({ text: 'help', command: '/growthos' });
      const json3 = (await (await post(renamed, signed(renamed, FORM))).json()) as Record<
        string,
        string
      >;
      assert.match(json3.text, /`\/growthos chats`/);

      const unknown = commandBody({ text: 'dance' });
      const json2 = (await (await post(unknown, signed(unknown, FORM))).json()) as Record<
        string,
        string
      >;
      assert.match(json2.text, /don't know `dance`/);
    });
    assert.equal(peer.frames.filter((f) => f.type === 'action').length, 0);
  });

  it('says so when the desktop is offline or outdated', async () => {
    const api = createFakeSlackApi();
    const hub = new SlackRelayHub(api);
    await withRouter(createSlackCommandsRouter({ config, hub, api }), '/commands', async (post) => {
      const body = commandBody({ text: 'new' });
      const json = (await (await post(body, signed(body, FORM))).json()) as Record<string, string>;
      assert.match(json.text, /not connected/);

      hub.registerOwner('T1:U1', createFakePeer('old'), 'D1');
      const again = commandBody({ text: 'new' });
      const json2 = (await (await post(again, signed(again, FORM))).json()) as Record<
        string,
        string
      >;
      assert.match(json2.text, /Update York IE/);
    });
  });

  it('acks within the window even when Slack is slow, then forwards once', async () => {
    const { api, hub, peer } = setup();
    api.gate = new Promise<void>(() => {});
    await withRouter(createSlackCommandsRouter({ config, hub, api }), '/commands', async (post) => {
      const body = commandBody({
        text: 'new plan the offsite',
        channel_id: 'C123',
        trigger_id: 'fixed',
      });
      const started = Date.now();
      const res = await post(body, signed(body, FORM));
      assert.ok(Date.now() - started < 1_000);
      const json = (await res.json()) as Record<string, string>;
      assert.equal(json.text, "Starting a new chat… I'll reply in your York IE DM.");

      const retry = await post(body, signed(body, FORM));
      assert.equal(retry.status, 200);
      await flushAsync();
    });
    const actions = peer.frames.filter((f) => f.type === 'action');
    assert.equal(actions.length, 1);
    assert.deepEqual(
      { name: actions[0].name, arg: actions[0].arg },
      { name: 'new', arg: 'plan the offsite' }
    );
    api.gate = null;
  });
});
