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
