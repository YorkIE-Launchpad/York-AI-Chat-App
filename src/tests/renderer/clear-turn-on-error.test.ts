import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../renderer/store';
import { clearTurnStateOnServerError } from '../../renderer/utils/clear-turn-on-error';

describe('clearTurnStateOnServerError', () => {
  beforeEach(() => {
    useAppStore.setState({
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      isLoading: false,
      pendingQuestionsBySessionId: {},
    });
  });

  it('clears active turn so Processing cannot stick after a server error', () => {
    const sessionId = 'session-err-1';
    useAppStore.getState().setActiveSession(sessionId);
    useAppStore.getState().setLoading(true);
    useAppStore.getState().addMessage(sessionId, {
      id: 'msg-user-1',
      sessionId,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      timestamp: Date.now(),
    });
    useAppStore.getState().activateNextTurn(sessionId, 'pending-step-1');

    expect(useAppStore.getState().sessionStates[sessionId]?.activeTurn).toEqual({
      stepId: 'pending-step-1',
      userMessageId: 'msg-user-1',
    });

    clearTurnStateOnServerError(useAppStore.getState());

    expect(useAppStore.getState().isLoading).toBe(false);
    expect(useAppStore.getState().sessionStates[sessionId]?.activeTurn).toBeNull();
    expect(useAppStore.getState().sessionStates[sessionId]?.pendingTurns).toEqual([]);
  });
});
