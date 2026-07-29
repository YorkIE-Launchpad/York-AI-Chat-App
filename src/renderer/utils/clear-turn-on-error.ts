/**
 * Clear turn / loading state after a server error so "Processing..." cannot stick
 * when session.continue / session.start fails before session.status arrives.
 */
export function clearTurnStateOnServerError(store: {
  activeSessionId: string | null;
  sessionStates: Record<string, { activeTurn: unknown; pendingTurns?: unknown[] } | undefined>;
  setLoading: (loading: boolean) => void;
  finishExecutionClock: (sessionId: string) => void;
  clearActiveTurn: (sessionId: string) => void;
  clearPendingTurns: (sessionId: string) => void;
  clearQueuedMessages: (sessionId: string) => void;
  clearPendingQuestion: (sessionId: string) => void;
}): void {
  store.setLoading(false);
  const sessionIds = new Set<string>();
  if (store.activeSessionId) sessionIds.add(store.activeSessionId);
  for (const [sid, ss] of Object.entries(store.sessionStates)) {
    if (ss?.activeTurn || (ss?.pendingTurns?.length ?? 0) > 0) {
      sessionIds.add(sid);
    }
  }
  for (const sessionId of sessionIds) {
    store.finishExecutionClock(sessionId);
    store.clearActiveTurn(sessionId);
    store.clearPendingTurns(sessionId);
    store.clearQueuedMessages(sessionId);
    store.clearPendingQuestion(sessionId);
  }
}
