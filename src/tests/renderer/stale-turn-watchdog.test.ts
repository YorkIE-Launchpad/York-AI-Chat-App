import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../renderer/types';
import {
  STALE_TURN_FORCE_CLEAR_MESSAGE,
  STALE_TURN_FORCE_CLEAR_MS,
  STALE_TURN_RECONCILE_MS,
  applyStaleTurnDecision,
  decideStaleTurnAction,
  findStaleActiveTurnSessionIds,
  resolveMainSessionStatus,
} from '../../renderer/utils/stale-turn-watchdog';

function makeSession(id: string, status: Session['status'] = 'idle'): Session {
  return {
    id,
    title: 't',
    status,
    createdAt: 1,
    updatedAt: 1,
    cwd: '',
    mountedPaths: [],
    allowedTools: [],
    memoryEnabled: true,
  };
}

describe('stale-turn-watchdog', () => {
  it('finds sessions with activeTurn quieter than the reconcile window', () => {
    const now = 1_000_000;
    const ids = findStaleActiveTurnSessionIds({
      now,
      lastServerEventAt: {
        fresh: now - 1_000,
        stale: now - STALE_TURN_RECONCILE_MS,
        never: 0,
      },
      sessionStates: {
        fresh: { activeTurn: { stepId: 'a', userMessageId: 'u' } },
        stale: { activeTurn: { stepId: 'b', userMessageId: 'u' } },
        never: { activeTurn: { stepId: 'c', userMessageId: 'u' } },
        idle: { activeTurn: null },
      },
    });
    expect(ids.sort()).toEqual(['never', 'stale']);
  });

  it('decides clear_idle when main is not running after reconcile quiet', () => {
    expect(
      decideStaleTurnAction({
        quietMs: STALE_TURN_RECONCILE_MS,
        mainStatus: 'idle',
      })
    ).toEqual({ action: 'clear_idle' });
    expect(
      decideStaleTurnAction({
        quietMs: STALE_TURN_RECONCILE_MS,
        mainStatus: 'completed',
      })
    ).toEqual({ action: 'clear_idle' });
  });

  it('does not force-clear a still-running session until the longer quiet window', () => {
    expect(
      decideStaleTurnAction({
        quietMs: STALE_TURN_RECONCILE_MS,
        mainStatus: 'running',
      })
    ).toEqual({ action: 'none' });
    expect(
      decideStaleTurnAction({
        quietMs: STALE_TURN_FORCE_CLEAR_MS,
        mainStatus: 'running',
      })
    ).toEqual({ action: 'force_clear_running' });
  });

  it('does not force-clear while awaiting user input even past the quiet window', () => {
    expect(
      decideStaleTurnAction({
        quietMs: STALE_TURN_FORCE_CLEAR_MS,
        mainStatus: 'running',
        awaitingUserInput: true,
      })
    ).toEqual({ action: 'none' });
    expect(
      decideStaleTurnAction({
        quietMs: STALE_TURN_FORCE_CLEAR_MS,
        mainStatus: 'running',
        awaitingUserInput: false,
      })
    ).toEqual({ action: 'force_clear_running' });
  });

  it('still clears idle when main is not running even if awaiting user input', () => {
    expect(
      decideStaleTurnAction({
        quietMs: STALE_TURN_RECONCILE_MS,
        mainStatus: 'idle',
        awaitingUserInput: true,
      })
    ).toEqual({ action: 'clear_idle' });
  });

  it('resolves main session status from the list payload', () => {
    const sessions = [makeSession('s1', 'running'), makeSession('s2', 'idle')];
    expect(resolveMainSessionStatus(sessions, 's2')).toBe('idle');
    expect(resolveMainSessionStatus(sessions, 'missing')).toBeUndefined();
  });

  it('clears turn state when reconciling an idle main session', () => {
    const store = {
      updateSession: vi.fn(),
      finishExecutionClock: vi.fn(),
      setLoading: vi.fn(),
      clearActiveTurn: vi.fn(),
      clearPendingTurns: vi.fn(),
      clearQueuedMessages: vi.fn(),
      clearPendingQuestion: vi.fn(),
      addMessage: vi.fn(),
    };
    applyStaleTurnDecision(store, 's1', { action: 'clear_idle' });
    expect(store.updateSession).toHaveBeenCalledWith('s1', { status: 'idle' });
    expect(store.clearActiveTurn).toHaveBeenCalledWith('s1');
    expect(store.setLoading).toHaveBeenCalledWith(false);
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it('adds a recoverable error and clears when force-clearing a hung running turn', () => {
    const store = {
      updateSession: vi.fn(),
      finishExecutionClock: vi.fn(),
      setLoading: vi.fn(),
      clearActiveTurn: vi.fn(),
      clearPendingTurns: vi.fn(),
      clearQueuedMessages: vi.fn(),
      clearPendingQuestion: vi.fn(),
      addMessage: vi.fn(),
    };
    applyStaleTurnDecision(
      store,
      's1',
      { action: 'force_clear_running' },
      {
        now: 42,
        messageId: 'msg-stale',
      }
    );
    expect(store.addMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        id: 'msg-stale',
        content: [{ type: 'text', text: STALE_TURN_FORCE_CLEAR_MESSAGE }],
      })
    );
    expect(store.clearActiveTurn).toHaveBeenCalledWith('s1');
    // Keep local status running so Stop remains available.
    expect(store.updateSession).not.toHaveBeenCalled();
  });
});
