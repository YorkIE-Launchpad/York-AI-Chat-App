import type { Message, Session, SessionStatus } from '../types';

/** How often the renderer polls for orphaned active turns. */
export const STALE_TURN_WATCHDOG_INTERVAL_MS = 15_000;

/** After this quiet period, reconcile session status with main. */
export const STALE_TURN_RECONCILE_MS = 90_000;

/**
 * After this quiet period while main still reports running, clear local turn
 * state and surface a recoverable error (main activity timeout remains 5 min).
 */
export const STALE_TURN_FORCE_CLEAR_MS = 180_000;

export const STALE_TURN_FORCE_CLEAR_MESSAGE =
  '**Connection issue**: The response stopped updating. You can try sending again or press Stop.';

export type StaleTurnStore = {
  updateSession: (sessionId: string, updates: { status: SessionStatus }) => void;
  finishExecutionClock: (sessionId: string) => void;
  setLoading: (loading: boolean) => void;
  clearActiveTurn: (sessionId: string) => void;
  clearPendingTurns: (sessionId: string) => void;
  clearQueuedMessages: (sessionId: string) => void;
  clearPendingQuestion: (sessionId: string) => void;
  addMessage: (sessionId: string, message: Message) => void;
};

/** Same cleanup as session.status !== 'running' in useIPC. */
export function clearTurnStateForSession(store: StaleTurnStore, sessionId: string): void {
  store.finishExecutionClock(sessionId);
  store.setLoading(false);
  store.clearActiveTurn(sessionId);
  store.clearPendingTurns(sessionId);
  store.clearQueuedMessages(sessionId);
  store.clearPendingQuestion(sessionId);
}

export type StaleTurnDecision =
  | { action: 'none' }
  | { action: 'clear_idle' }
  | { action: 'force_clear_running' };

/**
 * Decide how to recover an orphaned activeTurn given quiet time and main status.
 */
export function decideStaleTurnAction(params: {
  quietMs: number;
  mainStatus: SessionStatus | undefined;
}): StaleTurnDecision {
  const { quietMs, mainStatus } = params;
  if (quietMs < STALE_TURN_RECONCILE_MS) return { action: 'none' };
  if (mainStatus && mainStatus !== 'running') return { action: 'clear_idle' };
  if (quietMs >= STALE_TURN_FORCE_CLEAR_MS) return { action: 'force_clear_running' };
  return { action: 'none' };
}

/** Apply a stale-turn decision to the store. */
export function applyStaleTurnDecision(
  store: StaleTurnStore,
  sessionId: string,
  decision: StaleTurnDecision,
  options?: { now?: number; messageId?: string }
): void {
  if (decision.action === 'none') return;

  if (decision.action === 'clear_idle') {
    store.updateSession(sessionId, { status: 'idle' });
    clearTurnStateForSession(store, sessionId);
    return;
  }

  // force_clear_running: unstick the UI but keep local status as running so Stop
  // remains available until main eventually goes idle (or the user stops).
  const now = options?.now ?? Date.now();
  store.addMessage(sessionId, {
    id: options?.messageId ?? `stale-turn-${sessionId}-${now}`,
    sessionId,
    role: 'assistant',
    content: [{ type: 'text', text: STALE_TURN_FORCE_CLEAR_MESSAGE }],
    timestamp: now,
  });
  clearTurnStateForSession(store, sessionId);
}

/** Session ids that still have an activeTurn and have been quiet long enough to check. */
export function findStaleActiveTurnSessionIds(params: {
  now: number;
  lastServerEventAt: Record<string, number>;
  sessionStates: Record<string, { activeTurn: unknown } | undefined>;
  reconcileAfterMs?: number;
}): string[] {
  const reconcileAfterMs = params.reconcileAfterMs ?? STALE_TURN_RECONCILE_MS;
  const result: string[] = [];
  for (const [sessionId, ss] of Object.entries(params.sessionStates)) {
    if (!ss?.activeTurn) continue;
    const lastAt = params.lastServerEventAt[sessionId] ?? 0;
    if (params.now - lastAt >= reconcileAfterMs) {
      result.push(sessionId);
    }
  }
  return result;
}

export function resolveMainSessionStatus(
  sessions: Session[] | null | undefined,
  sessionId: string
): SessionStatus | undefined {
  return sessions?.find((s) => s.id === sessionId)?.status;
}
