import { useEffect } from 'react';
import { isAskGrowthOSHotkey } from '../utils/ask-growthos-hotkey';
import { useAppStore } from '../store';

/**
 * Registers the in-window Ask Growth OS hotkey (Cmd/Ctrl+Shift+Space)
 * as a fallback when the main-process globalShortcut is unavailable.
 */
export function useAskGrowthOSHotkey(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAskGrowthOSHotkey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      useAppStore.getState().toggleAskGrowthOS();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}
