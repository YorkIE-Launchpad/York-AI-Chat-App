import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../renderer/store';
import type { ChatLoopStatus } from '../../renderer/types';

describe('chatLoopBySessionId store', () => {
  beforeEach(() => {
    useAppStore.setState({ chatLoopBySessionId: {} });
  });

  it('sets and clears loop status per session', () => {
    const status: ChatLoopStatus = {
      sessionId: 's1',
      kind: 'interval',
      prompt: 'check',
      intervalMs: 60_000,
      tickCount: 1,
      maxIterations: null,
      startedAt: Date.now(),
      nextTickAt: null,
      stopReason: null,
    };

    useAppStore.getState().setChatLoopStatus('s1', status);
    expect(useAppStore.getState().chatLoopBySessionId.s1).toEqual(status);

    useAppStore.getState().setChatLoopStatus('s1', null);
    expect(useAppStore.getState().chatLoopBySessionId.s1).toBeUndefined();
  });
});
