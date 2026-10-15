import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../src/main/remote/remote-config-store', () => ({
  remoteConfigStore: {
    getAll: () => ({
      gateway: { enabled: false, autoApproveSafeTools: true },
      channels: {},
    }),
    getGatewayConfig: () => ({ enabled: false }),
    getSlackRelayConfig: () => ({ enabled: true }),
    isEnabled: () => false,
    getPairedUsers: () => [],
  },
}));

import { RemoteManager } from '../src/main/remote/remote-manager';
import { SLACK_RELAY_CHANNEL_ID } from '../src/main/remote/channels/slack/slack-relay-channel';
import { PERMISSION_AUTO_APPROVE_MS } from '../src/shared/permission-policy';
import { unmarkStrictRemoteSession } from '../src/main/config/permission-rules-store';
import type { RemoteMessage, RemoteResponse } from '../src/main/remote/types';
import type { Session } from '../src/renderer/types/index';

const OWNER = 'U0OWNER';
const SESSION_ID = 'actual-session-1';

function slackMessage(text: string): RemoteMessage {
  return {
    id: `msg-${Math.random()}`,
    channelType: 'slack',
    channelId: SLACK_RELAY_CHANNEL_ID,
    sender: { id: OWNER, isBot: false },
    content: { type: 'text', text },
    timestamp: Date.now(),
    isGroup: false,
    isMentioned: true,
  };
}

describe('RemoteManager strict Slack relay policy', () => {
  let allowedRoot: string;
  let outsideRoot: string;
  let manager: RemoteManager;
  let sent: RemoteResponse[];
  let startCalls: Array<{ cwd?: string; options?: { strictRemote?: boolean } }>;
  const notify = vi.fn();

  beforeEach(() => {
    allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-allowed-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-outside-'));
    sent = [];
    startCalls = [];
    notify.mockReset();

    manager = new RemoteManager();
    manager.setAgentExecutor({
      startSession: async (title, _prompt, cwd, options) => {
        startCalls.push({ cwd, options });
        return { id: SESSION_ID, title } as never;
      },
      continueSession: async () => {},
      stopSession: async () => {},
      validateWorkingDirectory: async () => null,
    });
    manager.setSlackRelayProvider({
      isSlackConnected: () => true,
      getSlackUserId: () => OWNER,
      getSlackUserToken: async () => 'xoxp-test',
      getUpgradeHeaders: async () => ({}),
      getAllowedRoots: () => [allowedRoot],
      notify,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.setStrictChannel('slack', true);
    internals.gateway = {
      running: true,
      sendResponse: async (response: RemoteResponse) => {
        sent.push(response);
      },
    };
    internals.messageRouter.onResponse(async (response: RemoteResponse) => {
      sent.push(response);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    unmarkStrictRemoteSession(SESSION_ID);
    fs.rmSync(allowedRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  async function startRemoteSession(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).messageRouter.routeMessage(slackMessage('hello'));
  }

  function lastSentText(): string {
    const last = sent[sent.length - 1];
    return last.content.markdown ?? last.content.text ?? '';
  }

  it('starts relay sessions as strict and notifies the desktop', async () => {
    await startRemoteSession();
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].options).toEqual({ strictRemote: true });
    expect(notify).toHaveBeenCalledWith('Remote session started', expect.any(String));
  });

  it('rejects a working directory outside the allowed roots', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).messageRouter.routeMessage(
      slackMessage(`[cwd: ${outsideRoot}] list files`)
    );
    expect(startCalls).toHaveLength(0);
    expect(lastSentText()).toContain('outside the folders allowed');
  });

  it('rejects a symlink that escapes the allowed roots', async () => {
    const link = path.join(allowedRoot, 'escape');
    fs.symlinkSync(outsideRoot, link);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).messageRouter.routeMessage(slackMessage(`[cwd: ${link}] list files`));
    expect(startCalls).toHaveLength(0);
  });

  it('accepts a working directory inside the allowed roots', async () => {
    const inside = path.join(allowedRoot, 'project');
    fs.mkdirSync(inside);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).messageRouter.routeMessage(slackMessage(`[cwd: ${inside}] list files`));
    expect(startCalls).toHaveLength(1);
  });

  it('does not auto-approve "safe" tools and never offers or honors Always allow', async () => {
    await startRemoteSession();
    const pending = manager.handlePermissionRequest(SESSION_ID, 'tool-1', 'Read', {
      path: '/tmp/x',
    });
    await vi.waitFor(() => expect(lastSentText()).toContain('Needs your authorization'));
    expect(lastSentText()).not.toContain('Always allow');

    const handled = await manager.handlePotentialInteractionResponse(
      'slack',
      SLACK_RELAY_CHANNEL_ID,
      OWNER,
      'always'
    );
    expect(handled).toBe(true);
    await expect(pending).resolves.toEqual({ allow: false });
  });

  it('approves once on "y" without remembering', async () => {
    await startRemoteSession();
    const pending = manager.handlePermissionRequest(SESSION_ID, 'tool-2', 'bash', {
      command: 'ls',
    });
    await vi.waitFor(() => expect(lastSentText()).toContain('Needs your authorization'));
    await manager.handlePotentialInteractionResponse('slack', SLACK_RELAY_CHANNEL_ID, OWNER, 'y');
    await expect(pending).resolves.toEqual({ allow: true });
    expect(notify).toHaveBeenCalledWith('Remote action approved', expect.stringContaining('bash'));
  });

  it('ignores replies from anyone but the session owner', async () => {
    await startRemoteSession();
    const pending = manager.handlePermissionRequest(SESSION_ID, 'tool-3', 'bash', {});
    await vi.waitFor(() => expect(lastSentText()).toContain('Needs your authorization'));
    const handled = await manager.handlePotentialInteractionResponse(
      'slack',
      SLACK_RELAY_CHANNEL_ID,
      'U0STRANGER',
      'y'
    );
    expect(handled).toBe(false);
    await manager.handlePotentialInteractionResponse('slack', SLACK_RELAY_CHANNEL_ID, OWNER, 'n');
    await expect(pending).resolves.toEqual({ allow: false });
  });

  it('denies when unanswered within the session-manager timeout', async () => {
    await startRemoteSession();
    vi.useFakeTimers();
    const pending = manager.handlePermissionRequest(SESSION_ID, 'tool-4', 'bash', {});
    await vi.advanceTimersByTimeAsync(PERMISSION_AUTO_APPROVE_MS + 10);
    await expect(pending).resolves.toEqual({ allow: false });
  });

  it('falls back to the text prompt when no relay channel is connected', async () => {
    await startRemoteSession();
    void manager.handlePermissionRequest(SESSION_ID, 'tool-6', 'bash', { command: 'ls' });
    await vi.waitFor(() => expect(lastSentText()).toContain('Needs your authorization'));
  });

  it('truncates very large tool inputs in the prompt', async () => {
    await startRemoteSession();
    void manager.handlePermissionRequest(SESSION_ID, 'tool-5', 'write', {
      content: 'x'.repeat(10_000),
    });
    await vi.waitFor(() => expect(lastSentText()).toContain('Needs your authorization'));
    expect(lastSentText().length).toBeLessThan(2_500);
    expect(lastSentText()).toContain('truncated');
  });
});

describe('RemoteManager interactive Slack relay', () => {
  const OTHER_ID = 'desktop-chat-2';
  let allowedRoot: string;
  let manager: RemoteManager;
  let relay: ReturnType<typeof createFakeRelay>;
  let startCalls: string[];
  let continueCalls: string[];
  let stopCalls: string[];
  let sessions: Map<string, Session>;

  function createFakeRelay() {
    const calls = {
      status: [] as Array<{ handle: string; phase: string; label?: string }>,
      replies: [] as Array<{ handle: string | null; text: string; footer?: string }>,
      approvals: [] as Array<{ handle: string; request: Record<string, unknown> }>,
      closed: [] as Array<{ approvalId: string; outcome: string }>,
      chatLists: [] as Array<{ handle: string; chats: Array<Record<string, unknown>> }>,
      notices: [] as Array<{ handle: string; text: string }>,
    };
    return {
      calls,
      connected: true,
      latestHandle: 'h-latest' as string | null,
      sendStatus: (handle: string, phase: string, label?: string) => {
        calls.status.push({ handle, phase, label });
      },
      sendReply: async (handle: string | null, text: string, footer?: string) => {
        calls.replies.push({ handle, text, footer });
      },
      sendApproval: (handle: string, request: Record<string, unknown>) => {
        calls.approvals.push({ handle, request });
        return true;
      },
      closeApproval: (approvalId: string, outcome: string) => {
        calls.closed.push({ approvalId, outcome });
        return true;
      },
      sendChatList: (handle: string, chats: Array<Record<string, unknown>>) => {
        calls.chatLists.push({ handle, chats });
        return true;
      },
      sendNotice: (handle: string, text: string) => {
        calls.notices.push({ handle, text });
        return true;
      },
    };
  }

  function session(id: string, overrides: Partial<Session> = {}): Session {
    return {
      id,
      title: `Chat ${id}`,
      status: 'idle',
      updatedAt: Date.now(),
      createdAt: Date.now(),
      ...overrides,
    } as Session;
  }

  function relayMessage(text: string, replyHandle: string): RemoteMessage {
    return { ...slackMessage(text), raw: { replyHandle } };
  }

  beforeEach(() => {
    allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-interactive-'));
    startCalls = [];
    continueCalls = [];
    stopCalls = [];
    sessions = new Map([[OTHER_ID, session(OTHER_ID, { cwd: allowedRoot, updatedAt: 1 })]]);

    manager = new RemoteManager();
    manager.setAgentExecutor({
      startSession: async (title) => {
        startCalls.push(title);
        const created = session(`${SESSION_ID}-${startCalls.length}`, {
          title: 'Quarterly report',
        });
        sessions.set(created.id, created);
        return created;
      },
      continueSession: async (sessionId) => {
        continueCalls.push(sessionId);
      },
      stopSession: async (sessionId) => {
        stopCalls.push(sessionId);
      },
      validateWorkingDirectory: async () => null,
      hasSession: (id) => sessions.has(id),
      listSessions: () => [...sessions.values()],
      getSession: (id) => sessions.get(id) ?? null,
    });
    manager.setSlackRelayProvider({
      isSlackConnected: () => true,
      getSlackUserId: () => OWNER,
      getSlackUserToken: async () => 'xoxp-test',
      getUpgradeHeaders: async () => ({}),
      getAllowedRoots: () => [allowedRoot],
      notify: vi.fn(),
    });
    relay = createFakeRelay();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.setStrictChannel('slack', true);
    internals.slackRelayChannel = relay;
    internals.gateway = { running: true, sendResponse: async () => {} };
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const id of sessions.keys()) unmarkStrictRemoteSession(id);
    fs.rmSync(allowedRoot, { recursive: true, force: true });
  });

  const firstSessionId = () => `${SESSION_ID}-1`;

  it('shows live status and sends one combined answer with a footer when the turn ends', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    expect(relay.calls.status[0]).toEqual({ handle: 'h1', phase: 'start', label: undefined });

    await manager.sendToolProgress(firstSessionId(), 'Bash', 'running');
    manager.noteSlackTurnActivity(firstSessionId(), 'thinking');
    manager.noteSlackTurnActivity(firstSessionId(), 'thinking');
    await manager.sendResponseToChannel(firstSessionId(), 'Part one');
    await manager.sendResponseToChannel(firstSessionId(), 'Part two');
    expect(relay.calls.replies).toHaveLength(0);

    await manager.clearSessionBuffer(firstSessionId(), 'idle');
    expect(relay.calls.status.map((s) => [s.phase, s.label])).toEqual([
      ['start', undefined],
      ['step', 'Running a command'],
      ['thinking', 'Thinking…'],
      ['done', undefined],
    ]);
    expect(relay.calls.replies).toEqual([
      {
        handle: 'h1',
        text: 'Part one\n\nPart two',
        footer: expect.stringContaining('Chat: Quarterly report'),
      },
    ]);
  });

  it('marks the status as failed when the turn errors', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    await manager.clearSessionBuffer(firstSessionId(), 'error');
    expect(relay.calls.status.at(-1)).toMatchObject({ handle: 'h1', phase: 'error' });
  });

  it('resolves permissions from Allow/Deny buttons and closes the card', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    const pending = manager.handlePermissionRequest(firstSessionId(), 'tool-a', 'Bash', {
      command: 'npm test',
    });
    await vi.waitFor(() => expect(relay.calls.approvals).toHaveLength(1));
    const { handle, request } = relay.calls.approvals[0];
    expect(handle).toBe('h1');
    expect(request).toMatchObject({ toolName: 'Bash', summary: 'Command: npm test' });

    await manager.handleSlackRelayAction({
      kind: 'approval',
      approvalId: request.approvalId as string,
      decision: 'allow',
    });
    await expect(pending).resolves.toEqual({ allow: true });
    expect(relay.calls.closed).toEqual([{ approvalId: request.approvalId, outcome: 'allowed' }]);
  });

  it('still accepts a typed "no" and closes the card as denied', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    const pending = manager.handlePermissionRequest(firstSessionId(), 'tool-b', 'Bash', {});
    await vi.waitFor(() => expect(relay.calls.approvals).toHaveLength(1));
    await manager.handlePotentialInteractionResponse('slack', SLACK_RELAY_CHANNEL_ID, OWNER, 'no');
    await expect(pending).resolves.toEqual({ allow: false });
    expect(relay.calls.closed[0].outcome).toBe('denied');
  });

  it('expires the card when the approval times out, and ignores late clicks', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    vi.useFakeTimers();
    const pending = manager.handlePermissionRequest(firstSessionId(), 'tool-c', 'Bash', {});
    await vi.advanceTimersByTimeAsync(PERMISSION_AUTO_APPROVE_MS + 10);
    await expect(pending).resolves.toEqual({ allow: false });
    const approvalId = relay.calls.approvals[0].request.approvalId as string;
    expect(relay.calls.closed).toEqual([{ approvalId, outcome: 'expired' }]);

    await manager.handleSlackRelayAction({ kind: 'approval', approvalId, decision: 'allow' });
    expect(relay.calls.closed.at(-1)).toEqual({ approvalId, outcome: 'expired' });
  });

  it('answers a plain "help" DM and typed /growth commands without running the agent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const intercept = (manager as any).handleSlackRelayTextCommand.bind(manager);
    expect(await intercept(relayMessage('Help', 'h1'))).toBe(true);
    expect(relay.calls.notices.at(-1)).toMatchObject({ handle: 'h1' });
    expect(relay.calls.notices.at(-1)!.text).toContain('Control York IE from Slack');

    expect(await intercept(relayMessage('/growthOS chats', 'h2'))).toBe(true);
    expect(relay.calls.chatLists.at(-1)).toMatchObject({ handle: 'h2' });

    expect(await intercept(relayMessage('can you help me with a memo?', 'h3'))).toBe(false);
    expect(startCalls).toHaveLength(0);
  });

  it('/growth new starts a fresh chat for the next message', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    await manager.handleSlackRelayAction({ kind: 'command', name: 'new', replyHandle: 'h2' });
    expect(relay.calls.notices.at(-1)).toMatchObject({ handle: 'h2' });
    expect(relay.calls.notices.at(-1)!.text).toContain('Started a new chat');

    await manager.routeMessage(relayMessage('again', 'h3'));
    expect(startCalls).toHaveLength(2);
    expect(continueCalls).toHaveLength(0);
  });

  it('/growth new with a message runs it right away', async () => {
    await manager.handleSlackRelayAction({
      kind: 'command',
      name: 'new',
      arg: 'summarize my inbox',
      replyHandle: 'h2',
    });
    expect(startCalls).toHaveLength(1);
    expect(relay.calls.status[0]).toMatchObject({ handle: 'h2', phase: 'start' });
  });

  it('/growth chats lists recent chats and Open switches the DM to that chat', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    await manager.handleSlackRelayAction({ kind: 'command', name: 'chats', replyHandle: 'h2' });
    const { chats } = relay.calls.chatLists[0];
    expect(chats.map((c) => [c.title, c.current])).toEqual([
      ['Quarterly report', true],
      [`Chat ${OTHER_ID}`, false],
    ]);

    await manager.handleSlackRelayAction({
      kind: 'command',
      name: 'open',
      arg: chats[1].token as string,
      replyHandle: 'h3',
    });
    expect(relay.calls.notices.at(-1)!.text).toContain(`Switched to "Chat ${OTHER_ID}"`);

    await manager.routeMessage(relayMessage('continue please', 'h4'));
    expect(continueCalls).toEqual([OTHER_ID]);
    expect(manager.isRemoteSession(firstSessionId())).toBe(false);
  });

  it('refuses unknown chat tokens and chats outside the allowed folders', async () => {
    await manager.handleSlackRelayAction({
      kind: 'command',
      name: 'open',
      arg: 'x'.repeat(24),
      replyHandle: 'h1',
    });
    expect(relay.calls.notices.at(-1)!.text).toContain('expired');

    sessions.set('outside', session('outside', { cwd: os.tmpdir(), updatedAt: Date.now() + 10 }));
    await manager.handleSlackRelayAction({ kind: 'command', name: 'chats', replyHandle: 'h2' });
    const outside = relay.calls.chatLists[0].chats.find((c) => c.title === 'Chat outside')!;
    await manager.handleSlackRelayAction({
      kind: 'command',
      name: 'open',
      arg: outside.token as string,
      replyHandle: 'h3',
    });
    expect(relay.calls.notices.at(-1)!.text).toContain("isn't allowed");
    unmarkStrictRemoteSession('outside');
  });

  it('/growth stop stops a running chat and /growth status describes it', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    await manager.handleSlackRelayAction({ kind: 'command', name: 'stop', replyHandle: 'h2' });
    expect(relay.calls.notices.at(-1)!.text).toBe('Nothing is running right now.');

    sessions.get(firstSessionId())!.status = 'running';
    await manager.handleSlackRelayAction({ kind: 'command', name: 'status', replyHandle: 'h3' });
    expect(relay.calls.notices.at(-1)!.text).toContain('Current chat: Quarterly report');
    expect(relay.calls.notices.at(-1)!.text).toContain('working on it');

    await manager.handleSlackRelayAction({ kind: 'command', name: 'stop', replyHandle: 'h4' });
    expect(stopCalls).toEqual([firstSessionId()]);
    expect(relay.calls.notices.at(-1)!.text).toBe('Stopped.');
  });
});
