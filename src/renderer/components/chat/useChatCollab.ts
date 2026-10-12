import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';
import type { Session } from '../../types';
import type { CollabRoomState } from '../../../shared/collab/types';

/** Shared-chat state (room, lease, peers) plus share / export / take-turn actions. */
export function useChatCollab(
  activeSessionId: string | null,
  activeSession: Session | null | undefined,
  messageCount: number
) {
  const { t } = useTranslation();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const {
    exportSession,
    shareCollabSession,
    getCollabState,
    acquireCollabTurn,
    getSessionMessages,
    isElectron,
  } = useIPC();
  const [collabState, setCollabState] = useState<CollabRoomState | null>(null);
  const [collabInviteShown, setCollabInviteShown] = useState<string | null>(null);

  const handleExportChat = async () => {
    if (!activeSessionId || !isElectron) return;
    if (activeSession?.incognito) {
      setGlobalNotice({
        id: `notice-export-${Date.now()}`,
        type: 'warning',
        message: '',
        messageKey: 'chat.exportIncognitoBlocked',
      });
      return;
    }
    try {
      const result = await exportSession(activeSessionId);
      if (result.cancelled) return;
      if (result.success && result.path) {
        setGlobalNotice({
          id: `notice-export-${Date.now()}`,
          type: 'success',
          message: '',
          messageKey: 'chat.exportSuccess',
          messageValues: { path: result.path },
        });
      } else {
        setGlobalNotice({
          id: `notice-export-${Date.now()}`,
          type: 'error',
          message: result.error || t('chat.exportFailed'),
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `notice-export-${Date.now()}`,
        type: 'error',
        message: error instanceof Error ? error.message : t('chat.exportFailed'),
      });
    }
  };

  const handleShareChat = async () => {
    if (!activeSessionId || !isElectron) return;
    if (activeSession?.incognito) {
      setGlobalNotice({
        id: `notice-share-${Date.now()}`,
        type: 'warning',
        message: '',
        messageKey: 'chat.shareIncognitoBlocked',
      });
      return;
    }
    try {
      const result = await shareCollabSession(activeSessionId);
      if (!result.success || !result.roomId) {
        setGlobalNotice({
          id: `notice-share-${Date.now()}`,
          type: 'error',
          message: result.error || t('chat.shareFailed'),
        });
        return;
      }
      const roomId = result.roomId;
      setCollabInviteShown(roomId);
      try {
        await navigator.clipboard.writeText(roomId);
        setGlobalNotice({
          id: `notice-share-${Date.now()}`,
          type: 'success',
          message: '',
          messageKey: 'chat.shareSuccess',
          messageValues: { roomId },
        });
      } catch {
        setGlobalNotice({
          id: `notice-share-${Date.now()}`,
          type: 'success',
          message: roomId,
        });
      }
      const state = await getCollabState(activeSessionId);
      setCollabState(state);
    } catch (error) {
      setGlobalNotice({
        id: `notice-share-${Date.now()}`,
        type: 'error',
        message: error instanceof Error ? error.message : t('chat.shareFailed'),
      });
    }
  };

  const handleTakeTurn = async () => {
    if (!activeSessionId) return;
    const result = await acquireCollabTurn(activeSessionId);
    if (!result.success) {
      setGlobalNotice({
        id: `notice-turn-${Date.now()}`,
        type: 'error',
        message: result.error || t('chat.collabTakeTurn'),
      });
      return;
    }
    if (result.state) setCollabState(result.state);
  };

  useEffect(() => {
    if (!activeSessionId || !isElectron) {
      setCollabState(null);
      return;
    }
    let cancelled = false;
    void getCollabState(activeSessionId).then((state) => {
      if (!cancelled) setCollabState(state);
    });
    const unsubState = window.electronAPI.collab.onState((state) => {
      if (state.sessionId === activeSessionId) setCollabState(state);
    });
    const unsubAwareness = window.electronAPI.collab.onAwareness((payload) => {
      if (payload.sessionId !== activeSessionId) return;
      setCollabState((prev) => {
        if (!prev) return prev;
        const lease = payload.lease;
        const localSub = prev.localSub;
        const canPrompt = Boolean(localSub) && (!lease || lease.holderSub === localSub);
        return {
          ...prev,
          awarenessPartial: payload.partial,
          peersOnline: payload.peersOnline,
          lease,
          canPrompt,
        };
      });
    });
    return () => {
      cancelled = true;
      unsubState();
      unsubAwareness();
    };
  }, [activeSessionId, getCollabState, isElectron]);

  const isSharedChat = Boolean(activeSession?.collabRoomId || collabState?.roomId);
  const leaseHeldByOther = Boolean(
    collabState?.lease &&
    collabState.localSub &&
    collabState.lease.holderSub !== collabState.localSub
  );
  const collabBlocksComposer = isSharedChat && collabState != null && leaseHeldByOther;

  const showCollabWaitingPeer =
    Boolean(collabState) &&
    collabState?.role === 'member' &&
    collabState.connection === 'connected' &&
    !collabState.peersOnline &&
    messageCount === 0;
  const collabPeerNames = collabState?.peerNames ?? [];
  const collabRoomIdLabel = collabInviteShown || collabState?.roomId || '';
  const collabPresenceLabel =
    collabState?.connection === 'connected'
      ? collabPeerNames.length > 0
        ? t('chat.collabWithPeers', { names: collabPeerNames.join(', ') })
        : t('chat.collabWaitingForPeerShort')
      : collabState?.connection || '';

  // When a peer comes online, reload transcript in case sync projected messages
  const prevPeersOnlineRef = useRef(false);
  useEffect(() => {
    if (!activeSessionId || !isElectron || !isSharedChat) {
      prevPeersOnlineRef.current = false;
      return;
    }
    const peersOnline = Boolean(collabState?.peersOnline);
    if (peersOnline && !prevPeersOnlineRef.current) {
      void getSessionMessages(activeSessionId).then((msgs) => {
        if (msgs?.length) {
          useAppStore.getState().setMessages(activeSessionId, msgs);
        }
      });
    }
    prevPeersOnlineRef.current = peersOnline;
  }, [activeSessionId, collabState?.peersOnline, getSessionMessages, isElectron, isSharedChat]);

  return {
    collabState,
    isSharedChat,
    collabBlocksComposer,
    showCollabWaitingPeer,
    collabPeerNames,
    collabRoomIdLabel,
    collabPresenceLabel,
    handleExportChat,
    handleShareChat,
    handleTakeTurn,
  };
}
