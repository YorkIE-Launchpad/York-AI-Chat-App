import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatLoopManager, extractAssistantText } from '../../main/loop/chat-loop-manager';
import { isGoalCompleteInText } from '../../shared/loop/types';

describe('extractAssistantText', () => {
  it('returns latest assistant text', () => {
    const text = extractAssistantText([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'GOAL_STATUS: in_progress' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done\nGOAL_STATUS: complete' }] },
    ]);
    expect(text).toContain('GOAL_STATUS: complete');
    expect(isGoalCompleteInText(text!)).toBe(true);
  });
});

describe('ChatLoopManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs immediately and arms next tick', async () => {
    vi.useFakeTimers();
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const manager = new ChatLoopManager({
      api: {
        continueSession,
        getSessionStatus: () => 'idle',
        getLatestAssistantText: () => 'ok',
        sessionExists: () => true,
      },
    });

    const status = manager.start({
      sessionId: 's1',
      kind: 'interval',
      prompt: 'check deploy',
      intervalMs: 30_000,
      runImmediately: true,
    });

    expect(status.sessionId).toBe('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(continueSession).toHaveBeenCalledWith('s1', 'check deploy', [
      { type: 'text', text: 'check deploy' },
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(continueSession.mock.calls.length).toBeGreaterThanOrEqual(2);

    manager.stop('s1');
    expect(manager.status('s1')).toBeNull();
  });

  it('stops goal loop when complete marker appears', async () => {
    vi.useFakeTimers();
    const continueSession = vi.fn().mockResolvedValue(undefined);
    let assistantText = 'GOAL_STATUS: in_progress';
    const manager = new ChatLoopManager({
      api: {
        continueSession,
        getSessionStatus: () => 'idle',
        getLatestAssistantText: () => assistantText,
        sessionExists: () => true,
      },
    });

    manager.start({
      sessionId: 's2',
      kind: 'goal',
      prompt: 'make tests pass',
      intervalMs: 30_000,
      maxIterations: 5,
      runImmediately: true,
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(continueSession).toHaveBeenCalled();
    const firstCall = continueSession.mock.calls[0];
    expect(firstCall[0]).toBe('s2');
    // Agent receives the full tick template; UI/DB user message is the goal text only.
    expect(String(firstCall[1])).toContain('Continue working toward this goal');
    expect(String(firstCall[1])).toContain('make tests pass');
    expect(firstCall[2]).toEqual([{ type: 'text', text: 'make tests pass' }]);
    assistantText = 'All good\nGOAL_STATUS: complete';
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(600);
    expect(manager.status('s2')).toBeNull();
  });
});
