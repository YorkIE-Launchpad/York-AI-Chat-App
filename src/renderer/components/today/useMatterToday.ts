import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_MATTER_RUNTIME,
  MATTER_DEFAULT_SNOOZE_MS,
  type MatterItem,
  type MatterMeeting,
  type MatterOpportunity,
  type MatterSnapshot,
} from '../../../shared/matter';
import { buildMatterSessionTitle } from '../../../shared/matter-chat';
import type { Loop, LoopsSnapshot } from '../../../shared/loops';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';

export const EMPTY_MATTER_SNAPSHOT: MatterSnapshot = {
  items: [],
  meetings: [],
  meetingsLastFetch: null,
  meetingsFetching: false,
  lenses: [],
  focusScore: 100,
  criticalCount: 0,
  warningCount: 0,
  healthyCount: 0,
  pulse: '',
  lastScan: null,
  scanning: false,
  inScanWindow: true,
  connectorHealth: [],
  connectedCount: 0,
  muteRules: [],
  morningBrief: null,
  settings: DEFAULT_MATTER_RUNTIME,
  profileSummary: null,
  opportunities: [],
};

export type MatterItemAction = 'done' | 'dismiss' | 'snooze' | 'pin' | 'unpin' | 'open';

/**
 * Matter snapshot + every action Today exposes (signals, meetings, opportunities,
 * Follow-ups promotion). Matter chats always open in the Hub workspace.
 */
export function useMatterToday() {
  const { t } = useTranslation();
  const { startSession, createSession } = useIPC();
  const workingDir = useAppStore((s) => s.workingDir);
  const setMatterBadgeCount = useAppStore((s) => s.setMatterBadgeCount);
  const setMatterChatDraft = useAppStore((s) => s.setMatterChatDraft);
  const matterPrepLoadingId = useAppStore((s) => s.matterPrepLoadingId);
  const setMatterPrepLoadingId = useAppStore((s) => s.setMatterPrepLoadingId);

  const [snapshot, setSnapshot] = useState<MatterSnapshot>(EMPTY_MATTER_SNAPSHOT);
  const [loaded, setLoaded] = useState(false);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [busy, setBusy] = useState(false);
  const [clearingNow, setClearingNow] = useState(false);
  const [prepLoadingId, setPrepLoadingId] = useState<string | null>(null);

  const applySnapshot = useCallback(
    (next: MatterSnapshot) => {
      setSnapshot(next);
      setLoaded(true);
      setMatterBadgeCount(next.settings.enabled ? next.criticalCount : 0);
    },
    [setMatterBadgeCount]
  );

  const applyLoops = useCallback((next: LoopsSnapshot) => setLoops(next.loops), []);

  useEffect(() => {
    const api = window.electronAPI?.matter;
    if (!api) {
      setLoaded(true);
      return;
    }
    void api
      .getSnapshot()
      .then(applySnapshot)
      .catch(() => setLoaded(true));
    return api.onUpdated(applySnapshot);
  }, [applySnapshot]);

  useEffect(() => {
    const api = window.electronAPI?.loops;
    if (!api) return;
    void api
      .list()
      .then(applyLoops)
      .catch(() => undefined);
    return api.onChanged(applyLoops);
  }, [applyLoops]);

  const enabled = snapshot.settings.enabled !== false;

  const trackedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const loop of loops) {
      if (loop.status !== 'open') continue;
      keys.add(loop.fingerprint);
      if (loop.sourceRef.matterItemId) keys.add(loop.sourceRef.matterItemId);
    }
    return keys;
  }, [loops]);

  const isTracked = useCallback(
    (item: MatterItem) => trackedKeys.has(item.id) || trackedKeys.has(item.fingerprint),
    [trackedKeys]
  );

  const addToFollowUps = useCallback(
    (item: MatterItem) => {
      if (!window.electronAPI?.loops) return;
      void window.electronAPI.loops
        .promoteFromMatter(item.id)
        .then(applyLoops)
        .catch((error: unknown) => console.warn('[Follow-ups] Promote failed', error));
    },
    [applyLoops]
  );

  const runAction = useCallback(
    async (item: MatterItem, action: MatterItemAction, mute?: boolean) => {
      if (!window.electronAPI?.matter) return;
      const next = await window.electronAPI.matter.applyAction({
        itemId: item.id,
        action: action === 'pin' && item.pinned ? 'unpin' : action,
        snoozeUntil: action === 'snooze' ? Date.now() + MATTER_DEFAULT_SNOOZE_MS : undefined,
        mute: mute ? { kind: 'fingerprint', key: item.fingerprint, label: item.title } : null,
      });
      applySnapshot(next);
      if (action === 'open') {
        const url =
          item.sourceRef.url?.trim() ||
          item.rawDetails?.match(/https?:\/\/[^\s"'<>)\\]]+/i)?.[0]?.replace(/[.,;:]+$/, '');
        if (url) await window.electronAPI.openExternal(url);
      }
    },
    [applySnapshot]
  );

  const openItemChat = useCallback(
    async (item: MatterItem) => {
      setBusy(true);
      try {
        const session = await createSession(
          buildMatterSessionTitle(item.title),
          workingDir || undefined,
          { division: 'hub' }
        );
        if (!session) return;
        setMatterChatDraft(session.id, {
          itemIds: [item.id],
          composerPrefill: t('matter.chatComposerPrefill'),
          contextSummary: {
            title: item.title,
            summary: item.summary,
            whyItMatters: item.whyItMatters,
            suggestedAction: item.suggestedAction,
            sourceLabel: item.sourceRef.label || item.source,
            url: item.sourceRef.url,
          },
        });
      } finally {
        setBusy(false);
      }
    },
    [createSession, setMatterChatDraft, t, workingDir]
  );

  const prepMeeting = useCallback(
    async (meeting: MatterMeeting) => {
      if (!window.electronAPI?.matter?.prepMeeting) return;
      setPrepLoadingId(meeting.id);
      setMatterPrepLoadingId(meeting.id);
      try {
        applySnapshot(await window.electronAPI.matter.prepMeeting(meeting.id));
      } catch (error) {
        console.error('[Today] Prep failed:', error);
      } finally {
        setPrepLoadingId(null);
        setMatterPrepLoadingId(null);
      }
    },
    [applySnapshot, setMatterPrepLoadingId]
  );

  const refreshMeetings = useCallback(async () => {
    if (!window.electronAPI?.matter?.refreshMeetings || !enabled) return;
    try {
      applySnapshot(await window.electronAPI.matter.refreshMeetings());
    } catch (error) {
      console.error('[Today] Meetings refresh failed:', error);
    }
  }, [applySnapshot, enabled]);

  const openMeetingLink = useCallback(async (meeting: MatterMeeting) => {
    const url = meeting.htmlLink?.trim();
    if (!url || !window.electronAPI?.openExternal) return;
    await window.electronAPI.openExternal(url);
  }, []);

  const runOpportunityAction = useCallback(
    async (opp: MatterOpportunity, action: 'dismiss' | 'snooze') => {
      if (!window.electronAPI?.matter) return;
      applySnapshot(
        await window.electronAPI.matter.opportunityAction({
          opportunityId: opp.id,
          action,
          snoozeUntil: action === 'snooze' ? Date.now() + MATTER_DEFAULT_SNOOZE_MS : undefined,
        })
      );
    },
    [applySnapshot]
  );

  const openOpportunitySource = useCallback(async (opp: MatterOpportunity) => {
    const url = opp.sourceRef.url?.trim();
    if (!url || !window.electronAPI?.openExternal) return;
    await window.electronAPI.openExternal(url);
  }, []);

  const openOpportunityChat = useCallback(
    async (opp: MatterOpportunity) => {
      if (!window.electronAPI?.matter) return;
      setBusy(true);
      try {
        const built = await window.electronAPI.matter.buildOpportunityChatPrompt(
          t('matter.opportunities.chatPrefill'),
          opp.id
        );
        await startSession(
          buildMatterSessionTitle(opp.title),
          built.prompt,
          workingDir || undefined,
          {
            division: 'hub',
          }
        );
      } finally {
        setBusy(false);
      }
    },
    [startSession, t, workingDir]
  );

  const scanNow = useCallback(async () => {
    if (!window.electronAPI?.matter || !enabled) return;
    setBusy(true);
    try {
      applySnapshot(await window.electronAPI.matter.scanNow());
    } finally {
      setBusy(false);
    }
  }, [applySnapshot, enabled]);

  const clearNowOrbit = useCallback(async () => {
    if (!window.electronAPI?.matter) return;
    setClearingNow(true);
    try {
      applySnapshot(await window.electronAPI.matter.clearNowOrbit());
    } finally {
      setClearingNow(false);
    }
  }, [applySnapshot]);

  return {
    snapshot,
    loaded,
    enabled,
    loops,
    busy,
    clearingNow,
    prepLoadingId: matterPrepLoadingId || prepLoadingId,
    applySnapshot,
    isTracked,
    addToFollowUps: window.electronAPI?.loops ? addToFollowUps : undefined,
    runAction,
    openItemChat,
    prepMeeting,
    refreshMeetings,
    openMeetingLink,
    runOpportunityAction,
    openOpportunitySource,
    openOpportunityChat,
    scanNow,
    clearNowOrbit,
  };
}

export type MatterToday = ReturnType<typeof useMatterToday>;
