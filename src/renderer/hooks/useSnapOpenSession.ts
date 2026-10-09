import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { useIPC } from './useIPC';
import type { Message, Session, TraceStep } from '../types';

/** Dispatched on `window` by useIPC when main asks to open a Screen Snap chat. */
export const SNAP_OPEN_SESSION_WINDOW_EVENT = 'growthos:snap-open-session';

/**
 * Opens the session of a Screen Snap panel chat ("Open in GrowthOS"). Pulls on
 * mount too, so a request made while this window was cold-starting is not lost.
 */
export function useSnapOpenSession(): void {
  const { invoke, isElectron } = useIPC();
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.snap) return;
    let pulling = false;

    const pull = async () => {
      if (pulling) return;
      pulling = true;
      try {
        const sessionId = await window.electronAPI.snap.takePendingOpen();
        if (!sessionId) return;

        const store = useAppStore.getState();
        if (!store.sessions.some((session) => session.id === sessionId)) {
          const sessions = await invokeRef.current<Session[]>({
            type: 'session.list',
            payload: {},
          });
          if (sessions) store.setSessions(sessions);
        }

        store.setShowSettings(false);
        store.setShowMatter(false);
        store.setAskGrowthOSOpen(false);
        useAppStore.getState().openSessionWithDivision(sessionId);

        const [messages, traceSteps] = await Promise.all([
          invokeRef.current<Message[]>({ type: 'session.getMessages', payload: { sessionId } }),
          invokeRef.current<TraceStep[]>({ type: 'session.getTraceSteps', payload: { sessionId } }),
        ]);
        useAppStore.getState().setMessages(sessionId, messages || []);
        useAppStore.getState().setTraceSteps(sessionId, traceSteps || []);
      } catch (error) {
        console.error('[ScreenSnap] Failed to open snap chat', error);
      } finally {
        pulling = false;
      }
    };

    const onOpen = () => void pull();
    window.addEventListener(SNAP_OPEN_SESSION_WINDOW_EVENT, onOpen);
    void pull();
    return () => window.removeEventListener(SNAP_OPEN_SESSION_WINDOW_EVENT, onOpen);
  }, [isElectron]);
}
