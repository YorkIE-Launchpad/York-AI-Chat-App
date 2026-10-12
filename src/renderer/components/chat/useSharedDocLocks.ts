import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';
import type { SharedDocLockState } from '../../../shared/shared-docs/lock-types';

/** Edit locks on this chat's shared docs; the composer locks while someone else edits. */
export function useSharedDocLocks(activeSessionId: string | null, isElectron: boolean) {
  const { listSharedDocs } = useIPC();
  const activeHtmlPreview = useAppStore((s) => s.activeHtmlPreview);
  const [sharedDocLocks, setSharedDocLocks] = useState<Record<string, SharedDocLockState>>({});

  useEffect(() => {
    const lockApi = window.electronAPI?.sharedDocs?.lock;
    if (!activeSessionId || !isElectron || !lockApi) {
      setSharedDocLocks({});
      return undefined;
    }
    let cancelled = false;
    const watchedRef: { current: Array<{ docId: string; canEdit: boolean }> } = { current: [] };

    void listSharedDocs(activeSessionId).then(async (result) => {
      if (cancelled || !result.success || !result.docs) return;
      const editDocs = result.docs.filter(
        (doc) => doc.permission === 'edit' || doc.permission === 'owner'
      );
      for (const doc of editDocs) {
        const entry = { docId: doc.id, canEdit: false };
        watchedRef.current.push(entry);
        const watchResult = await lockApi.watch(entry);
        if (cancelled) {
          void lockApi.unwatch(entry);
          return;
        }
        if (watchResult.success && watchResult.state) {
          setSharedDocLocks((prev) => ({ ...prev, [doc.id]: watchResult.state! }));
        }
      }
    });

    const unsub = lockApi.onState((state) => {
      setSharedDocLocks((prev) => ({ ...prev, [state.docId]: state }));
    });

    return () => {
      cancelled = true;
      unsub();
      for (const entry of watchedRef.current) {
        void lockApi.unwatch(entry);
      }
      watchedRef.current = [];
      setSharedDocLocks({});
    };
  }, [activeSessionId, isElectron, listSharedDocs]);

  const sharedDocBlockingLock = useMemo(() => {
    const previewId = activeHtmlPreview?.shared?.docId;
    if (previewId && sharedDocLocks[previewId]?.holderIsOther) {
      return sharedDocLocks[previewId];
    }
    return Object.values(sharedDocLocks).find((lock) => lock.holderIsOther) ?? null;
  }, [activeHtmlPreview?.shared?.docId, sharedDocLocks]);
  const sharedDocViewOnlyOpen = activeHtmlPreview?.shared?.permission === 'view';
  const sharedDocBlocksComposer = Boolean(sharedDocBlockingLock) || sharedDocViewOnlyOpen;
  const sharedDocBlockName =
    sharedDocBlockingLock?.holderName || sharedDocBlockingLock?.lease?.holderName || 'Someone';

  return { sharedDocBlocksComposer, sharedDocViewOnlyOpen, sharedDocBlockName };
}
