import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const relayWorkspace = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('../src/main/remote/remote-config-store', () => ({
  remoteConfigStore: {
    getSlackRelayWorkspace: () => relayWorkspace.value,
    setSlackRelayWorkspace: (value: unknown) => {
      relayWorkspace.value = value;
    },
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
  let startCalls: Array<{ cwd?: string; options?: { strictRemote?: boolean; content?: unknown } }>;
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

  it('sends Slack images to the agent as image blocks', async () => {
    const message = slackMessage('');
    message.content.images = [{ name: 'a.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).messageRouter.routeMessage(message);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].options).toEqual({
      strictRemote: true,
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
      ],
    });
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
  let startOptions: Array<Record<string, unknown> | undefined>;
  let continueCalls: string[];
  let stopCalls: string[];
  let sessions: Map<string, Session>;
  let currentModel: string;
  const selectModel = vi.fn();
  const MODELS = [
    { id: 'claude-sonnet', name: 'Claude Sonnet', provider: 'anthropic' as const },
    { id: 'claude-opus', name: 'Claude Opus', provider: 'anthropic' as const },
    { id: 'gpt-5', name: 'GPT-5', provider: 'openai' as const },
  ];
  const FOLDERS = [{ id: 'f1', name: 'Research', createdAt: 1, updatedAt: 2 }];
  const PROJECTS = [
    {
      canonicalKey: 'hub:p1',
      name: 'Acme Website',
      sources: { hub: true as const },
      hubProjectId: 'p1',
      clientName: 'Acme',
    },
  ];

  function createFakeRelay() {
    const calls = {
      status: [] as Array<{ handle: string; phase: string; label?: string }>,
      replies: [] as Array<{ handle: string | null; text: string; footer?: string }>,
      approvals: [] as Array<{ handle: string; request: Record<string, unknown> }>,
      closed: [] as Array<{ approvalId: string; outcome: string }>,
      chatLists: [] as Array<{ handle: string; chats: Array<Record<string, unknown>> }>,
      notices: [] as Array<{ handle: string; text: string }>,
      alerts: [] as string[],
      questions: [] as Array<{ handle: string; request: Record<string, unknown> }>,
      questionsClosed: [] as Array<{ questionId: string; outcome: string; answers?: string[][] }>,
      pickers: [] as Array<{
        handle: string;
        picker: {
          kind: string;
          note?: string;
          items: Array<{ token: string; label: string; detail: string; current: boolean }>;
        };
      }>,
    };
    return {
      calls,
      connected: true,
      supportsQuestions: true,
      supportsPickers: true,
      supportsAlerts: true,
      sendPicker: (handle: string, picker: (typeof calls.pickers)[number]['picker']) => {
        calls.pickers.push({ handle, picker });
        return true;
      },
      sendQuestion: (handle: string, request: Record<string, unknown>) => {
        calls.questions.push({ handle, request });
        return true;
      },
      closeQuestion: (questionId: string, outcome: string, answers?: string[][]) => {
        calls.questionsClosed.push({ questionId, outcome, ...(answers ? { answers } : {}) });
        return true;
      },
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
      sendAlert: (text: string) => {
        calls.alerts.push(text);
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
    startOptions = [];
    continueCalls = [];
    stopCalls = [];
    currentModel = 'claude-sonnet';
    relayWorkspace.value = null;
    sessions = new Map([[OTHER_ID, session(OTHER_ID, { cwd: allowedRoot, updatedAt: 1 })]]);

    manager = new RemoteManager();
    manager.setAgentExecutor({
      startSession: async (title, _prompt, _cwd, options) => {
        startCalls.push(title);
        startOptions.push(options);
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
      listModels: async () => MODELS,
      getCurrentModel: () => currentModel,
      selectModel: selectModel.mockImplementation(async (id: string) => {
        currentModel = id;
        return null;
      }),
      listWorkspaceSources: async () => ({ folders: FOLDERS, projects: PROJECTS }),
    });
    selectModel.mockClear();
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

  const QUESTIONS = [
    {
      question: 'Which format?',
      header: 'Format',
      options: [{ label: 'Deck', recommended: true }, { label: 'Doc' }],
    },
    {
      question: 'Which channels?',
      multiSelect: true,
      options: [{ label: 'Email' }, { label: 'LinkedIn' }, { label: 'Slack' }],
    },
  ];

  it('posts AskUserQuestion as a Slack card and answers from the buttons', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    const sendResponse = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).gateway.sendResponse = sendResponse;
    const pending = manager.handleQuestionRequest(firstSessionId(), 'ask-1', QUESTIONS);
    await vi.waitFor(() => expect(relay.calls.questions).toHaveLength(1));
    expect(sendResponse).not.toHaveBeenCalled();
    const { handle, request } = relay.calls.questions[0];
    expect(handle).toBe('h1');
    expect(request).toMatchObject({
      expiresInSec: 300,
      questions: [
        {
          question: 'Which format?',
          header: 'Format',
          options: [{ label: 'Deck', recommended: true }, { label: 'Doc' }],
        },
        { question: 'Which channels?', multiSelect: true },
      ],
    });
    expect(relay.calls.status.at(-1)?.label).toBe('Waiting for your answer…');

    const questionId = request.questionId as string;
    await manager.handleSlackRelayAction({ kind: 'answer', questionId, answers: [[1], [0, 2]] });
    await expect(pending).resolves.toBe(JSON.stringify({ 0: ['Doc'], 1: ['Email', 'Slack'] }));
    expect(relay.calls.questionsClosed).toEqual([
      { questionId, outcome: 'answered', answers: [['Doc'], ['Email', 'Slack']] },
    ]);
  });

  it('closes the card as skipped on Skip, and as expired on timeout or a late click', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    const skipped = manager.handleQuestionRequest(firstSessionId(), 'ask-2', QUESTIONS);
    await vi.waitFor(() => expect(relay.calls.questions).toHaveLength(1));
    const skipId = relay.calls.questions[0].request.questionId as string;
    await manager.handleSlackRelayAction({ kind: 'answer', questionId: skipId, answers: null });
    await expect(skipped).resolves.toBe('{}');
    expect(relay.calls.questionsClosed.at(-1)).toEqual({ questionId: skipId, outcome: 'skipped' });

    vi.useFakeTimers();
    const timedOut = manager.handleQuestionRequest(firstSessionId(), 'ask-3', QUESTIONS);
    await vi.waitFor(() => expect(relay.calls.questions).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);
    await expect(timedOut).resolves.toBeNull();
    const lateId = relay.calls.questions[1].request.questionId as string;
    expect(relay.calls.questionsClosed.at(-1)).toEqual({ questionId: lateId, outcome: 'expired' });

    await manager.handleSlackRelayAction({ kind: 'answer', questionId: lateId, answers: [[0]] });
    expect(relay.calls.questionsClosed.at(-1)).toEqual({ questionId: lateId, outcome: 'expired' });
  });

  it('falls back to the text prompt when the backend has no question cards', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    relay.supportsQuestions = false;
    const sendResponse = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).gateway.sendResponse = sendResponse;
    void manager.handleQuestionRequest(firstSessionId(), 'ask-4', QUESTIONS);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(relay.calls.questions).toHaveLength(0);
  });

  it('pushes Matter / Follow-up alerts through the GrowthOS bot when alerts are supported', () => {
    expect(manager.pushOwnerAlert('Matter — opportunity', 'Acme upsell')).toBe(true);
    expect(relay.calls.alerts).toEqual(['**Matter — opportunity**\nAcme upsell']);

    relay.supportsAlerts = false;
    expect(manager.pushOwnerAlert('Follow-up', 'Send deck')).toBe(false);
    expect(relay.calls.alerts).toHaveLength(1);
  });

  it('answers a plain "help" DM and typed /growth commands without running the agent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const intercept = (manager as any).handleSlackRelayTextCommand.bind(manager);
    expect(await intercept(relayMessage('Help', 'h1'))).toBe(true);
    expect(relay.calls.notices.at(-1)).toMatchObject({ handle: 'h1' });
    expect(relay.calls.notices.at(-1)!.text).toContain('Control York IE GrowthOS from Slack');
    expect(relay.calls.notices.at(-1)!.text).toContain('Follow-ups and Matter opportunities');

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

  const command = (name: 'model' | 'workspace' | 'pick', arg?: string) =>
    manager.handleSlackRelayAction({
      kind: 'command',
      name,
      replyHandle: 'h-cmd',
      ...(arg ? { arg } : {}),
    });

  it('/growthos model lists models and a button switches the app-wide model', async () => {
    await command('model');
    const { picker } = relay.calls.pickers[0];
    expect(picker.kind).toBe('model');
    expect(picker.note).toBe('Current model: Claude Sonnet.');
    expect(picker.items.map((i) => [i.label, i.current])).toEqual([
      ['Auto', false],
      ['Claude Sonnet', true],
      ['Claude Opus', false],
      ['GPT-5', false],
    ]);

    await command('pick', picker.items[3].token);
    expect(selectModel).toHaveBeenCalledWith('gpt-5');
    expect(relay.calls.notices.at(-1)!.text).toBe(
      'Model switched to GPT-5. This also applies on your computer.'
    );

    await command('pick', picker.items[3].token);
    expect(relay.calls.notices.at(-1)!.text).toContain('That list has expired');
    await command('pick', picker.items[1].token);
    expect(selectModel).toHaveBeenCalledTimes(1);
  });

  it('/growthos model <name> switches directly, or narrows the list when ambiguous', async () => {
    await command('model', 'opus');
    expect(selectModel).toHaveBeenCalledWith('claude-opus');

    await command('model', 'claude');
    expect(relay.calls.pickers.at(-1)!.picker.items.map((i) => i.label)).toEqual([
      'Claude Sonnet',
      'Claude Opus',
    ]);

    await command('model', 'llama');
    expect(relay.calls.pickers.at(-1)!.picker.note).toContain('No model matches "llama"');

    await command('model', 'opus');
    expect(relay.calls.notices.at(-1)!.text).toBe('Already using Claude Opus.');
    expect(selectModel).toHaveBeenCalledTimes(1);
  });

  it('/growthos workspace switches where new Slack chats start', async () => {
    await manager.routeMessage(relayMessage('hi', 'h1'));
    expect(startOptions[0]).not.toHaveProperty('workspace');

    await command('workspace');
    const { picker } = relay.calls.pickers[0];
    expect(picker.kind).toBe('workspace');
    expect(picker.items.map((i) => [i.label, i.detail, i.current])).toEqual([
      ['General', 'Everyday chats', true],
      ['Hub', 'York IE Hub', false],
      ['Research', 'Personal folder', false],
      ['Acme Website', 'Project · Acme', false],
      ['Acme', 'Client · 1 project', false],
    ]);

    await command('pick', picker.items[3].token);
    expect(relayWorkspace.value).toMatchObject({ kind: 'project', canonicalKey: 'hub:p1' });
    expect(relay.calls.notices.at(-1)!.text).toBe(
      'Switched to the Acme Website workspace. Your next message starts a new chat there.'
    );

    await manager.routeMessage(relayMessage('plan the launch', 'h2'));
    expect(startCalls).toHaveLength(2);
    expect(startOptions[1]?.workspace).toMatchObject({ kind: 'project', name: 'Acme Website' });

    await command('workspace', 'general');
    expect(relayWorkspace.value).toBeNull();
    await command('workspace', 'nothing like this');
    expect(relay.calls.notices.at(-1)!.text).toContain('No workspace matches');

    await manager.handleSlackRelayAction({ kind: 'command', name: 'status', replyHandle: 'h3' });
    expect(relay.calls.notices.at(-1)!.text).toContain('Workspace: General');
    expect(relay.calls.notices.at(-1)!.text).toContain('Model: claude-sonnet');
  });

  it('falls back to a text list when the backend has no pickers', async () => {
    relay.supportsPickers = false;
    await command('model');
    expect(relay.calls.pickers).toHaveLength(0);
    const text = relay.calls.notices.at(-1)!.text;
    expect(text).toContain('• *Claude Sonnet* (Anthropic) – current');
    expect(text).toContain('`/growthos model <name>`');
  });
});
