import { useCallback, useMemo } from 'react';
import { useAppStore } from '../store';
import { useIPC } from './useIPC';
import type { BrainstormDetail } from '../../shared/brainstorm-types';

export const FOCUS_COMPOSER_EVENT = 'growthos:focus-composer';

function closeFeaturePages() {
  const s = useAppStore.getState();
  s.setShowSettings(false);
  s.setShowWorkflows(false);
  s.setShowLoops(false);
  s.setShowBrainstorm(false);
}

/** One place for page-to-page moves (sidebar, ⌘K, shortcuts, links). */
export function useNavigation() {
  const { deleteSession, getSessionMessages, getSessionTraceSteps, isElectron, invoke } = useIPC();

  /** Private chats are discarded when you leave them. */
  const discardIncognitoIfLeaving = useCallback(
    (nextSessionId: string | null) => {
      const state = useAppStore.getState();
      const currentId = state.activeSessionId;
      if (!currentId || currentId === nextSessionId) return;
      if (state.sessions.find((s) => s.id === currentId)?.incognito) deleteSession(currentId);
    },
    [deleteSession]
  );

  const goToday = useCallback(() => {
    discardIncognitoIfLeaving(null);
    const s = useAppStore.getState();
    s.setIncognitoDraft(false);
    s.setActiveSession(null);
    closeFeaturePages();
  }, [discardIncognitoIfLeaving]);

  const newChat = useCallback(
    (options?: { private?: boolean }) => {
      discardIncognitoIfLeaving(null);
      const s = useAppStore.getState();
      s.setIncognitoDraft(Boolean(options?.private));
      s.setActiveSession(null);
      closeFeaturePages();
      window.setTimeout(() => window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT)), 60);
    },
    [discardIncognitoIfLeaving]
  );

  const openFollowUps = useCallback(
    (tab?: 'mine' | 'waiting' | 'closed') => {
      discardIncognitoIfLeaving(null);
      const s = useAppStore.getState();
      s.setIncognitoDraft(false);
      if (tab) s.setFollowUpsTab(tab);
      s.setShowLoops(true);
    },
    [discardIncognitoIfLeaving]
  );

  const openAutomations = useCallback(
    (tab?: 'workflows' | 'schedules') => {
      discardIncognitoIfLeaving(null);
      const s = useAppStore.getState();
      s.setIncognitoDraft(false);
      if (tab) s.setAutomationsTab(tab);
      s.setShowWorkflows(true);
    },
    [discardIncognitoIfLeaving]
  );

  const openSettings = useCallback((tab?: string) => {
    const s = useAppStore.getState();
    if (tab) s.setSettingsTab(tab);
    s.setShowSettings(true);
  }, []);

  const openBrainstorm = useCallback(
    (id?: string | null) => {
      discardIncognitoIfLeaving(null);
      const s = useAppStore.getState();
      s.setIncognitoDraft(false);
      s.setActiveBrainstormId(id ?? null);
      s.setShowBrainstorm(true);
    },
    [discardIncognitoIfLeaving]
  );

  const openChat = useCallback(
    async (sessionId: string) => {
      const state = useAppStore.getState();
      const session = state.sessions.find((item) => item.id === sessionId);
      if (session?.kind === 'brainstorm') {
        discardIncognitoIfLeaving(sessionId);
        state.setIncognitoDraft(false);
        if (isElectron) {
          try {
            const detail = await invoke<BrainstormDetail | null>({
              type: 'brainstorm.getBySession',
              payload: { sessionId },
            });
            if (detail) {
              useAppStore.getState().upsertBrainstorm(detail);
              useAppStore.getState().setActiveBrainstormId(detail.id);
            }
            const existing = useAppStore.getState().sessionStates[sessionId];
            if (!existing?.messages?.length) {
              const messages = await getSessionMessages(sessionId);
              if (messages?.length) useAppStore.getState().setMessages(sessionId, messages);
            }
          } catch {
            /* still open the page */
          }
        }
        useAppStore.getState().setShowBrainstorm(true);
        return;
      }
      closeFeaturePages();
      const next = useAppStore.getState();
      if (next.activeSessionId !== sessionId) {
        discardIncognitoIfLeaving(sessionId);
        next.setIncognitoDraft(false);
        if (!next.openSessionWithDivision(sessionId)) return;
      }
      if (!isElectron) return;
      const existing = useAppStore.getState().sessionStates[sessionId];
      if (!existing?.messages?.length) {
        const messages = await getSessionMessages(sessionId);
        if (messages?.length) useAppStore.getState().setMessages(sessionId, messages);
      }
      if (!existing?.traceSteps?.length) {
        const steps = await getSessionTraceSteps(sessionId);
        useAppStore.getState().setTraceSteps(sessionId, steps || []);
      }
    },
    [discardIncognitoIfLeaving, getSessionMessages, getSessionTraceSteps, invoke, isElectron]
  );

  return useMemo(
    () => ({
      goToday,
      newChat,
      openFollowUps,
      openAutomations,
      openBrainstorm,
      openSettings,
      openChat,
      discardIncognitoIfLeaving,
    }),
    [
      goToday,
      newChat,
      openFollowUps,
      openAutomations,
      openBrainstorm,
      openSettings,
      openChat,
      discardIncognitoIfLeaving,
    ]
  );
}
