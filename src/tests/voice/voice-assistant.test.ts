import { describe, expect, it, vi } from 'vitest';

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  normalizeUrl,
  runAssistantAction,
  VoiceAgentBridge,
  type VoiceAgentBridgeDeps,
} from '../../main/voice/voice-assistant';

describe('normalizeUrl', () => {
  it('adds https to bare domains and rejects other schemes', () => {
    expect(normalizeUrl('github.com/york-ie')).toBe('https://github.com/york-ie');
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('hello')).toBeNull();
  });
});

describe('runAssistantAction', () => {
  it('searches the web and clips long results', async () => {
    const searchWeb = vi.fn(async () => 'x'.repeat(5000));
    const result = await runAssistantAction('web_search', { query: 'york ie' }, { searchWeb });
    expect(searchWeb).toHaveBeenCalledWith('york ie');
    expect(result.ok).toBe(true);
    expect(result.message.length).toBeLessThanOrEqual(3001);
  });

  it('opens only safe URLs', async () => {
    const openUrl = vi.fn(async () => undefined);
    await expect(
      runAssistantAction('open_url', { url: 'github.com' }, { openUrl })
    ).resolves.toEqual({ ok: true, message: 'Opened github.com.' });
    expect(openUrl).toHaveBeenCalledWith('https://github.com/');
    expect((await runAssistantAction('open_url', { url: 'file:///x' }, { openUrl })).ok).toBe(
      false
    );
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it('hands tasks to GrowthOS', async () => {
    const askAgent = vi.fn(async () => ({ ok: true, message: 'Priya is on leave.' }));
    const result = await runAssistantAction(
      'ask_growthos',
      { task: 'Who is on leave today?' },
      { askAgent }
    );
    expect(result.message).toBe('Priya is on leave.');
    expect(askAgent).toHaveBeenCalledWith('Who is on leave today?', undefined);
  });
});

function bridgeDeps(overrides: Partial<VoiceAgentBridgeDeps> = {}) {
  const sessions = new Set<string>();
  const deps = {
    startSession: vi.fn(async () => {
      sessions.add('s1');
      return { id: 's1' };
    }),
    continueSession: vi.fn(async () => undefined),
    hasSession: (id: string) => sessions.has(id),
    showSession: vi.fn(),
    ...overrides,
  };
  return deps;
}

const assistantMessage = (sessionId: string, text: string) => ({
  type: 'stream.message',
  payload: { sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const status = (sessionId: string, value: string) => ({
  type: 'session.status',
  payload: { sessionId, status: value },
});

describe('VoiceAgentBridge', () => {
  it('returns the final assistant reply when the run goes idle', async () => {
    const deps = bridgeDeps();
    const bridge = new VoiceAgentBridge(deps);
    const onProgress = vi.fn();
    const pending = bridge.ask('Who is on leave today?', onProgress);
    await vi.waitFor(() => expect(deps.startSession).toHaveBeenCalled());

    bridge.handleEvent(status('s1', 'running'));
    bridge.handleEvent({
      type: 'trace.step',
      payload: {
        sessionId: 's1',
        step: { type: 'tool_call', toolName: 'mcp__york-hub__list_leaves', status: 'running' },
      },
    });
    bridge.handleEvent(assistantMessage('other', 'ignore me'));
    bridge.handleEvent(assistantMessage('s1', 'Priya and Arjun are on leave.'));
    bridge.handleEvent(status('s1', 'idle'));

    await expect(pending).resolves.toEqual({ ok: true, message: 'Priya and Arjun are on leave.' });
    expect(onProgress).toHaveBeenCalledWith('Using york hub: list leaves…');
    expect(vi.mocked(deps.startSession).mock.calls[0][1]).toContain('Who is on leave today?');
  });

  it('continues the same chat for follow-ups until reset', async () => {
    const deps = bridgeDeps();
    const bridge = new VoiceAgentBridge(deps);
    const first = bridge.ask('first');
    await vi.waitFor(() => expect(deps.startSession).toHaveBeenCalledTimes(1));
    bridge.handleEvent(status('s1', 'idle'));
    await first;

    const second = bridge.ask('and tomorrow?');
    await vi.waitFor(() => expect(deps.continueSession).toHaveBeenCalledTimes(1));
    bridge.handleEvent(status('s1', 'idle'));
    await expect(second).resolves.toEqual({ ok: true, message: 'Done.' });

    bridge.reset();
    void bridge.ask('new topic');
    await vi.waitFor(() => expect(deps.startSession).toHaveBeenCalledTimes(2));
  });

  it('brings GrowthOS forward when a tool needs approval', async () => {
    const deps = bridgeDeps();
    const bridge = new VoiceAgentBridge(deps);
    const pending = bridge.ask('Post the update to Slack');
    await vi.waitFor(() => expect(deps.startSession).toHaveBeenCalled());
    bridge.handleEvent({
      type: 'permission.request',
      payload: { sessionId: 's1', toolName: 'mcp__slack__post_message' },
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('approval');
    expect(deps.showSession).toHaveBeenCalledWith('s1');
  });

  it('times out with a pointer to the chat', async () => {
    const deps = bridgeDeps();
    const bridge = new VoiceAgentBridge({ ...deps, timeoutMs: 10 });
    const result = await bridge.ask('slow task');
    expect(result).toEqual({
      ok: true,
      message: 'GrowthOS is still working on it. The answer will be in the GrowthOS chat.',
    });
  });

  it('reports a failed start', async () => {
    const bridge = new VoiceAgentBridge(
      bridgeDeps({
        startSession: vi.fn(async () => {
          throw new Error('No model configured');
        }),
      })
    );
    const result = await bridge.ask('anything');
    expect(result).toEqual({ ok: false, message: 'GrowthOS could not start: No model configured' });
  });
});
