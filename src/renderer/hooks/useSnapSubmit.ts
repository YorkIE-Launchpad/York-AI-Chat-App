import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { useIPC } from './useIPC';
import { getInitialSessionTitle } from '../../shared/session-title';
import type { ContentBlock } from '../types';

/** Dispatched on `window` by useIPC when main reports a queued Screen Snap. */
export const SNAP_SUBMIT_WINDOW_EVENT = 'growthos:snap-submit';

/**
 * Starts a new chat from a Screen Snap submitted in the floating composer.
 * Pulls on mount too, so a snap submitted while this window was cold-starting
 * is not lost.
 */
export function useSnapSubmit(): void {
  const { startSession, isElectron } = useIPC();
  const startSessionRef = useRef(startSession);
  startSessionRef.current = startSession;

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.snap) return;
    let pulling = false;

    const pull = async () => {
      if (pulling) return;
      pulling = true;
      try {
        const pending = await window.electronAPI.snap.takePendingSubmit();
        if (!pending) return;

        const store = useAppStore.getState();
        store.setShowSettings(false);
        store.setShowMatter(false);
        store.setAskGrowthOSOpen(false);

        const content: ContentBlock[] = [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: pending.image.mediaType,
              data: pending.image.base64,
            },
          },
          { type: 'text', text: pending.text },
        ];
        await startSessionRef.current(
          getInitialSessionTitle(pending.text),
          content,
          store.workingDir || undefined
        );
      } catch (error) {
        console.error('[ScreenSnap] Failed to start chat from snap', error);
      } finally {
        pulling = false;
      }
    };

    const onSnap = () => void pull();
    window.addEventListener(SNAP_SUBMIT_WINDOW_EVENT, onSnap);
    void pull();
    return () => window.removeEventListener(SNAP_SUBMIT_WINDOW_EVENT, onSnap);
  }, [isElectron]);
}
