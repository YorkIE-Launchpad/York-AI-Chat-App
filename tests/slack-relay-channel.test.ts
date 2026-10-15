import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  SlackRelayChannel,
  SLACK_RELAY_CHANNEL_ID,
  slackRelayReplyHandleOf,
} from '../src/main/remote/channels/slack/slack-relay-channel';
import {
  parseSlackRelayAction,
  type SlackRelayAction,
} from '../src/main/remote/channels/slack/slack-relay-protocol';
import type { RemoteMessage } from '../src/main/remote/types';

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  terminate(): void {
    this.close();
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  frame(payload: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)), false);
  }
}

const OWNER = 'U0OWNER';
let channel: SlackRelayChannel | undefined;

async function createChannel(overrides: { wsUrl?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const headersSeen: Array<Record<string, string>> = [];
  channel = new SlackRelayChannel({
    getUpgradeHeaders: async () => ({ Authorization: 'Bearer id-token' }),
    getSlackUserToken: async () => 'xoxp-user-token',
    expectedSlackUserId: OWNER,
    wsUrl: overrides.wsUrl ?? 'wss://backend.example/slack-relay/ws',
    createSocket: (_url, headers) => {
      headersSeen.push(headers);
      const socket = new FakeSocket();
      sockets.push(socket);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return socket as any;
    },
  });
  const messages: RemoteMessage[] = [];
  channel.onMessage((m) => messages.push(m));
  return { channel, sockets, headersSeen, messages };
}

async function connectRegistered() {
  const ctx = await createChannel();
  await ctx.channel.start();
  const socket = ctx.sockets[0];
  socket.open();
  socket.frame({ type: 'registered', slackUserId: OWNER, teamId: 'T1' });
  return { ...ctx, socket };
}

afterEach(async () => {
  await channel?.stop();
  channel = undefined;
});

describe('SlackRelayChannel', () => {
  it('refuses insecure non-loopback backends', async () => {
    const { channel: c } = await createChannel({ wsUrl: 'ws://backend.example/slack-relay/ws' });
    await expect(c.start()).rejects.toThrow(/insecure/i);
  });

  it('sends credentials only in headers and the register frame', async () => {
    const { socket, headersSeen, channel: c } = await connectRegistered();
    expect(headersSeen[0]).toEqual({ Authorization: 'Bearer id-token' });
    expect(socket.sent[0]).toEqual({
      type: 'register',
      slackUserToken: 'xoxp-user-token',
      capabilities: ['status', 'approvals', 'commands', 'images'],
    });
    expect(c.connected).toBe(true);
  });

  it('halts when the backend registers a different Slack user', async () => {
    const { channel: c, sockets } = await createChannel();
    await c.start();
    sockets[0].open();
    sockets[0].frame({ type: 'registered', slackUserId: 'U0SOMEONEELSE' });
    expect(c.connected).toBe(false);
    expect(c.lastError).toMatch(/different Slack user/);
  });

  it('maps events to owner messages on the stable channel id', async () => {
    const { socket, messages } = await connectRegistered();
    socket.frame({ type: 'event', replyHandle: 'h1', text: '  run tests  ' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channelType: 'slack',
      channelId: SLACK_RELAY_CHANNEL_ID,
      sender: { id: OWNER, isBot: false },
      content: { type: 'text', text: 'run tests' },
      isGroup: false,
    });
  });

  it('ignores events before registration and malformed events', async () => {
    const { channel: c, sockets, messages } = await createChannel();
    await c.start();
    sockets[0].open();
    sockets[0].frame({ type: 'event', replyHandle: 'h1', text: 'too early' });
    sockets[0].frame({ type: 'registered', slackUserId: OWNER });
    sockets[0].frame({ type: 'event', replyHandle: '', text: 'no handle' });
    sockets[0].frame({ type: 'event', replyHandle: 'x'.repeat(65), text: 'long handle' });
    expect(messages).toHaveLength(0);
  });

  it('carries attached images, and accepts image-only events', async () => {
    const { socket, messages } = await connectRegistered();
    const png = { name: 'chart.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    socket.frame({ type: 'event', replyHandle: 'h1', text: 'what is this?', images: [png] });
    socket.frame({ type: 'event', replyHandle: 'h2', text: '', images: [png] });
    socket.frame({
      type: 'event',
      replyHandle: 'h3',
      text: '',
      images: [
        { mediaType: 'image/svg+xml', data: 'PHN2Zz4=' },
        { mediaType: 'image/png', data: 'not base64!' },
      ],
    });
    expect(messages.map((m) => m.content)).toEqual([
      { type: 'text', text: 'what is this?', images: [png] },
      { type: 'text', text: '', images: [png] },
    ]);
  });

  it('replies with the latest handle and resolves on reply_result', async () => {
    const { socket, channel: c } = await connectRegistered();
    socket.frame({ type: 'event', replyHandle: 'h1', text: 'first' });
    socket.frame({ type: 'event', replyHandle: 'h2', text: 'second' });

    const sending = c.send({
      channelType: 'slack',
      channelId: SLACK_RELAY_CHANNEL_ID,
      content: { type: 'text', text: 'done' },
    });
    const replyFrame = socket.sent.find((f) => f.type === 'reply')!;
    expect(replyFrame).toMatchObject({ replyHandle: 'h2', text: 'done' });
    socket.frame({ type: 'reply_result', requestId: replyFrame.requestId, ok: true });
    await expect(sending).resolves.toBeUndefined();
  });

  it('refuses to send to any other channel id', async () => {
    const { socket, channel: c } = await connectRegistered();
    socket.frame({ type: 'event', replyHandle: 'h1', text: 'hi' });
    await expect(
      c.send({ channelType: 'slack', channelId: 'C0PUBLIC', content: { type: 'text', text: 'x' } })
    ).rejects.toThrow(/reply route/);
  });

  it('stops permanently when replaced by another desktop', async () => {
    const { socket, channel: c, sockets } = await connectRegistered();
    socket.emit('close', 4409, Buffer.from('replaced'));
    expect(c.connected).toBe(false);
    expect(c.lastError).toMatch(/Another York IE GrowthOS desktop/);
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets).toHaveLength(1);
  });

  it('stops permanently on forbidden identity', async () => {
    const { socket, channel: c } = await connectRegistered();
    socket.emit('close', 4403, Buffer.from('forbidden'));
    expect(c.lastError).toMatch(/email must match/);
  });

  it('carries the reply handle on inbound messages', async () => {
    const { socket, messages } = await connectRegistered();
    socket.frame({ type: 'event', replyHandle: 'h1', text: 'hi' });
    expect(slackRelayReplyHandleOf(messages[0])).toBe('h1');
  });

  it('sends a footer with replies on a specific handle', async () => {
    const { socket, channel: c } = await connectRegistered();
    const sending = c.sendReply('h9', 'answer', 'Chat: X');
    const frame = socket.sent.find((f) => f.type === 'reply')!;
    expect(frame).toMatchObject({ replyHandle: 'h9', text: 'answer', footer: 'Chat: X' });
    socket.frame({ type: 'reply_result', requestId: frame.requestId, ok: true });
    await expect(sending).resolves.toBeUndefined();
  });

  it('coalesces status steps but sends start and done immediately', async () => {
    vi.useFakeTimers();
    try {
      const { socket, channel: c } = await connectRegistered();
      const statuses = () => socket.sent.filter((f) => f.type === 'status');

      c.sendStatus('h1', 'start');
      c.sendStatus('h1', 'step', 'Reading files');
      c.sendStatus('h1', 'step', 'Running a command');
      c.sendStatus('h1', 'step', 'Editing files');
      expect(statuses()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_100);
      expect(statuses()).toHaveLength(2);
      expect(statuses()[1]).toMatchObject({ phase: 'step', label: 'Editing files', steps: 3 });

      c.sendStatus('h1', 'step', 'Reading files');
      c.sendStatus('h1', 'done');
      expect(statuses().at(-1)).toMatchObject({ phase: 'done', steps: 4 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(statuses().at(-1)).toMatchObject({ phase: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends approval, chat list and notice frames only while connected', async () => {
    const { socket, channel: c } = await connectRegistered();
    expect(
      c.sendApproval('h1', {
        approvalId: 'a'.repeat(24),
        toolName: 'Bash',
        summary: 'Command: ls',
        expiresInSec: 60,
      })
    ).toBe(true);
    expect(c.closeApproval('a'.repeat(24), 'allowed')).toBe(true);
    expect(c.sendNotice('h1', 'Stopped.')).toBe(true);
    expect(socket.sent.map((f) => f.type)).toEqual(
      expect.arrayContaining(['approval', 'approval_closed', 'notice'])
    );

    socket.emit('close', 1006, Buffer.from(''));
    expect(c.sendNotice('h1', 'later')).toBe(false);
  });

  it('relays valid action frames and updates the reply route for commands', async () => {
    const { socket, channel: c } = await connectRegistered();
    const actions: SlackRelayAction[] = [];
    c.onAction((a) => actions.push(a));

    socket.frame({
      type: 'action',
      kind: 'approval',
      approvalId: 'b'.repeat(24),
      decision: 'allow',
    });
    socket.frame({ type: 'action', kind: 'command', name: 'chats', replyHandle: 'h-cmd' });
    socket.frame({ type: 'action', kind: 'approval', approvalId: 'short', decision: 'allow' });
    socket.frame({ type: 'action', kind: 'command', name: 'rm-rf', replyHandle: 'h-x' });
    socket.frame({
      type: 'action',
      kind: 'approval',
      approvalId: 'c'.repeat(24),
      decision: 'maybe',
    });

    expect(actions).toEqual([
      { kind: 'approval', approvalId: 'b'.repeat(24), decision: 'allow' },
      { kind: 'command', name: 'chats', replyHandle: 'h-cmd' },
    ]);
    expect(c.latestHandle).toBe('h-cmd');
  });

  it('sends question frames only when the backend advertises the feature', async () => {
    const request = {
      questionId: 'q'.repeat(24),
      expiresInSec: 300,
      questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
    };
    const old = await connectRegistered();
    expect(old.channel.supportsQuestions).toBe(false);
    expect(old.channel.sendQuestion('h1', request)).toBe(false);
    await old.channel.stop();

    const ctx = await createChannel();
    await ctx.channel.start();
    const socket = ctx.sockets[0];
    socket.open();
    socket.frame({ type: 'registered', slackUserId: OWNER, teamId: 'T1', features: ['questions'] });
    expect(ctx.channel.supportsQuestions).toBe(true);
    expect(ctx.channel.sendQuestion('h1', request)).toBe(true);
    expect(ctx.channel.closeQuestion(request.questionId, 'answered', [['A']])).toBe(true);
    expect(socket.sent.slice(-2)).toEqual([
      { type: 'question', replyHandle: 'h1', ...request },
      {
        type: 'question_closed',
        questionId: request.questionId,
        outcome: 'answered',
        answers: [['A']],
      },
    ]);
  });

  it('parses answer actions and rejects malformed ones', () => {
    const questionId = 'q'.repeat(24);
    expect(parseSlackRelayAction({ kind: 'answer', questionId, answers: [[1], [0, 2]] })).toEqual({
      kind: 'answer',
      questionId,
      answers: [[1], [0, 2]],
    });
    expect(parseSlackRelayAction({ kind: 'answer', questionId, answers: null })).toEqual({
      kind: 'answer',
      questionId,
      answers: null,
    });
    expect(parseSlackRelayAction({ kind: 'answer', questionId: 'short', answers: [] })).toBeNull();
    expect(parseSlackRelayAction({ kind: 'answer', questionId, answers: [[9]] })).toBeNull();
    expect(parseSlackRelayAction({ kind: 'answer', questionId, answers: [['0']] })).toBeNull();
    expect(
      parseSlackRelayAction({ kind: 'answer', questionId, answers: [[0], [0], [0], [0], [0]] })
    ).toBeNull();
  });
});
