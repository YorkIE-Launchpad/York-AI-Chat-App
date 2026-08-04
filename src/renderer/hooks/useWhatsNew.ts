import { useCallback, useEffect, useState } from 'react';
import type { WhatsNewPayload } from '../../shared/whats-new-types';

/**
 * Loads a pending What's New payload once after authentication shell mounts.
 */
export function useWhatsNew() {
  const [payload, setPayload] = useState<WhatsNewPayload | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const pending = await window.electronAPI.whatsNew.getPending();
        if (!cancelled && pending?.markdown) {
          setPayload(pending);
        }
      } catch (error) {
        console.warn('[useWhatsNew] Failed to load pending release notes:', error);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(async () => {
    setPayload(null);
    try {
      await window.electronAPI.whatsNew.markSeen();
    } catch (error) {
      console.warn('[useWhatsNew] Failed to mark version as seen:', error);
    }
  }, []);

  return { payload, dismiss };
}
