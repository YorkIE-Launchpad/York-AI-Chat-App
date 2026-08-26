import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw, Settings, X, Radio, Activity, Gauge, Plug, Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_MATTER_RUNTIME,
  MATTER_DEFAULT_SNOOZE_MS,
  relatedMatterLensId,
  type MatterItem,
  type MatterLensId,
  type MatterMeeting,
  type MatterSeverity,
  type MatterSnapshot,
} from '../../../shared/matter';
import { buildMatterSessionTitle } from '../../../shared/matter-chat';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';
import { MatterRadar } from './MatterRadar';
import { MatterSignalCard } from './MatterSignalCard';
import { MatterLenses } from './MatterLenses';
import { MatterAskBar } from './MatterAskBar';
import { MatterItemDetail } from './MatterItemDetail';
import { MatterMeetingCard } from './MatterMeetingCard';
import { MatterMeetingDetail } from './MatterMeetingDetail';

type MatterSeverityFilter = Extract<MatterSeverity, 'critical' | 'warning' | 'healthy'>;
type MatterLeftTab = 'signals' | 'calendar';

function briefLabelKey(
  hour: number
): 'matter.morningBrief' | 'matter.afternoonBrief' | 'matter.eveningBrief' {
  if (hour < 12) return 'matter.morningBrief';
  if (hour < 17) return 'matter.afternoonBrief';
  return 'matter.eveningBrief';
}

const SEVERITY_FILTERS: Array<{
  id: MatterSeverityFilter;
  label: string;
  countKey: 'criticalCount' | 'warningCount' | 'healthyCount';
  className: string;
  activeClassName: string;
}> = [
  {
    id: 'critical',
    label: 'CRITICAL',
    countKey: 'criticalCount',
    className: 'text-red-400 hover:bg-red-400/10',
    activeClassName: 'bg-red-400/15 ring-1 ring-red-400/40',
  },
  {
    id: 'warning',
    label: 'WARNING',
    countKey: 'warningCount',
    className: 'text-amber-400 hover:bg-amber-400/10',
    activeClassName: 'bg-amber-400/15 ring-1 ring-amber-400/40',
  },
  {
    id: 'healthy',
    label: 'HEALTHY',
    countKey: 'healthyCount',
    className: 'text-emerald-400 hover:bg-emerald-400/10',
    activeClassName: 'bg-emerald-400/15 ring-1 ring-emerald-400/40',
  },
];

const EMPTY_SNAPSHOT: MatterSnapshot = {
  items: [],
  meetings: [],
  meetingsLastFetch: null,
  meetingsFetching: false,
  lenses: [],
  focusScore: 100,
  criticalCount: 0,
  warningCount: 0,
  healthyCount: 0,
  pulse: 'Matter is warming up.',
  lastScan: null,
  scanning: false,
  inScanWindow: true,
  connectorHealth: [],
  connectedCount: 0,
  muteRules: [],
  morningBrief: null,
  settings: DEFAULT_MATTER_RUNTIME,
  profileSummary: null,
};

interface MatterPageProps {
  onClose: () => void;
}

export function MatterPage({ onClose }: MatterPageProps) {
  const { t } = useTranslation();
  const { startSession, createSession } = useIPC();
  const workingDir = useAppStore((s) => s.workingDir);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setMatterBadgeCount = useAppStore((s) => s.setMatterBadgeCount);
  const setMatterChatDraft = useAppStore((s) => s.setMatterChatDraft);
  const matterFocusMeetingId = useAppStore((s) => s.matterFocusMeetingId);
  const matterFocusPrepFullscreen = useAppStore((s) => s.matterFocusPrepFullscreen);
  const setMatterFocusMeetingId = useAppStore((s) => s.setMatterFocusMeetingId);

  const [snapshot, setSnapshot] = useState<MatterSnapshot>(EMPTY_SNAPSHOT);
  const [leftTab, setLeftTab] = useState<MatterLeftTab>('signals');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [openPrepFullscreen, setOpenPrepFullscreen] = useState(false);
  const clearOpenPrepFullscreen = useCallback(() => setOpenPrepFullscreen(false), []);
  const [activeLens, setActiveLens] = useState<MatterLensId | null>(null);
  const [activeSeverity, setActiveSeverity] = useState<MatterSeverityFilter | null>(null);
  const [clearingNow, setClearingNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prepLoadingId, setPrepLoadingId] = useState<string | null>(null);
  const matterPrepLoadingId = useAppStore((s) => s.matterPrepLoadingId);
  const setMatterPrepLoadingId = useAppStore((s) => s.setMatterPrepLoadingId);
  const activePrepLoadingId = matterPrepLoadingId || prepLoadingId;

  const applySnapshot = useCallback(
    (next: MatterSnapshot) => {
      setSnapshot(next);
      setMatterBadgeCount(next.settings.enabled ? next.criticalCount : 0);
    },
    [setMatterBadgeCount]
  );

  const matterEnabled = snapshot.settings.enabled !== false;

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.matter) return;
    const next = await window.electronAPI.matter.getSnapshot();
    applySnapshot(next);
  }, [applySnapshot]);

  useEffect(() => {
    void refresh();
    if (!window.electronAPI?.matter) return;
    return window.electronAPI.matter.onUpdated(applySnapshot);
  }, [refresh, applySnapshot]);

  useEffect(() => {
    if (!matterFocusMeetingId) return;
    const exists = snapshot.meetings.some((m) => m.id === matterFocusMeetingId);
    if (exists) {
      setLeftTab('calendar');
      setSelectedMeetingId(matterFocusMeetingId);
      setSelectedId(null);
      setOpenPrepFullscreen(matterFocusPrepFullscreen);
      setMatterFocusMeetingId(null);
      return;
    }
    // Wait for first meetings payload before giving up on the focus id.
    if (snapshot.meetingsLastFetch == null && snapshot.meetings.length === 0) return;
    setLeftTab('calendar');
    setOpenPrepFullscreen(false);
    setMatterFocusMeetingId(null);
  }, [
    matterFocusMeetingId,
    matterFocusPrepFullscreen,
    snapshot.meetings,
    snapshot.meetingsLastFetch,
    setMatterFocusMeetingId,
  ]);

  const filteredItems = useMemo(() => {
    let items = snapshot.items;
    if (activeLens) {
      const lens = snapshot.lenses.find((l) => l.id === activeLens);
      if (lens) {
        const ids = new Set(lens.itemIds);
        items = items.filter((i) => ids.has(i.id));
      }
    }
    if (activeSeverity) {
      items = items.filter((i) => i.severity === activeSeverity);
    }
    return items;
  }, [snapshot.items, snapshot.lenses, activeLens, activeSeverity]);

  const filterActive = Boolean(activeLens || activeSeverity);
  const highlightedIds = useMemo(() => new Set(filteredItems.map((i) => i.id)), [filteredItems]);

  const selectedItem = useMemo(
    () => snapshot.items.find((item) => item.id === selectedId) ?? null,
    [snapshot.items, selectedId]
  );

  const selectedMeeting = useMemo(
    () => snapshot.meetings.find((m) => m.id === selectedMeetingId) ?? null,
    [snapshot.meetings, selectedMeetingId]
  );

  const relatedLensId = useMemo(
    () => relatedMatterLensId(selectedItem, snapshot.lenses),
    [selectedItem, snapshot.lenses]
  );

  const briefLabel = t(briefLabelKey(new Date().getHours()));

  useEffect(() => {
    if (selectedId && !selectedItem) {
      setSelectedId(null);
    }
  }, [selectedId, selectedItem]);

  useEffect(() => {
    if (selectedMeetingId && !selectedMeeting) {
      setSelectedMeetingId(null);
    }
  }, [selectedMeetingId, selectedMeeting]);

  const runAction = async (
    item: MatterItem,
    action: 'done' | 'dismiss' | 'snooze' | 'pin' | 'unpin' | 'open',
    mute?: boolean
  ) => {
    if (!window.electronAPI?.matter) return;
    const next = await window.electronAPI.matter.applyAction({
      itemId: item.id,
      action: action === 'pin' && item.pinned ? 'unpin' : action === 'unpin' ? 'unpin' : action,
      snoozeUntil: action === 'snooze' ? Date.now() + MATTER_DEFAULT_SNOOZE_MS : undefined,
      mute: mute
        ? {
            kind: 'fingerprint',
            key: item.fingerprint,
            label: item.title,
          }
        : null,
    });
    applySnapshot(next);
    if (action === 'done' || action === 'dismiss' || action === 'snooze') {
      setSelectedId((current) => (current === item.id ? null : current));
    }
    if (action === 'open') {
      const url =
        item.sourceRef.url?.trim() ||
        item.rawDetails?.match(/https?:\/\/[^\s"'<>)\\]]+/i)?.[0]?.replace(/[.,;:]+$/, '');
      if (url) {
        await window.electronAPI.openExternal(url);
      }
    }
  };

  const openSignalChat = async (item: MatterItem) => {
    setBusy(true);
    try {
      const title = buildMatterSessionTitle(item.title);
      const session = await createSession(title, workingDir || undefined, { division: 'hub' });
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
      // setActiveSession (via createSession) already clears showMatter.
    } finally {
      setBusy(false);
    }
  };

  const prepMeeting = async (meeting: MatterMeeting) => {
    if (!window.electronAPI?.matter?.prepMeeting) return;
    setPrepLoadingId(meeting.id);
    setMatterPrepLoadingId(meeting.id);
    try {
      const next = await window.electronAPI.matter.prepMeeting(meeting.id);
      applySnapshot(next);
    } catch (error) {
      console.error('[Matter] Prep failed:', error);
    } finally {
      setPrepLoadingId(null);
      setMatterPrepLoadingId(null);
    }
  };

  const refreshMeetings = async () => {
    if (!window.electronAPI?.matter?.refreshMeetings || !matterEnabled) return;
    // Do not set global `busy` — that locks Scan Now / Ask while meetings
    // refresh. Main already pushes `meetingsFetching` via snapshot updates.
    try {
      const next = await window.electronAPI.matter.refreshMeetings();
      applySnapshot(next);
    } catch (error) {
      console.error('[Matter] Meetings refresh failed:', error);
    }
  };

  const openMeetingLink = async (meeting: MatterMeeting) => {
    const url = meeting.htmlLink?.trim();
    if (!url || !window.electronAPI?.openExternal) return;
    await window.electronAPI.openExternal(url);
  };

  /** Ask bar: user already typed intent — build prompt and run immediately. */
  const handleAsk = async (prompt: string, itemIds?: string[]) => {
    if (!window.electronAPI?.matter) return;
    setBusy(true);
    try {
      const built = await window.electronAPI.matter.buildChatPrompt(prompt, itemIds);
      const titleItem =
        (itemIds?.[0] && snapshot.items.find((i) => i.id === itemIds[0])) ||
        snapshot.items[0] ||
        null;
      const title = buildMatterSessionTitle(titleItem?.title ?? null);
      // Matter is org/context radar — always open chats in Hub, not General.
      await startSession(title, built.prompt, workingDir || undefined, { division: 'hub' });
    } finally {
      setBusy(false);
    }
  };

  const scanNow = async () => {
    if (!window.electronAPI?.matter || !matterEnabled) return;
    setBusy(true);
    try {
      const next = await window.electronAPI.matter.scanNow();
      applySnapshot(next);
    } finally {
      setBusy(false);
    }
  };

  const clearNowOrbit = async () => {
    if (!window.electronAPI?.matter) return;
    if (!snapshot.items.some((i) => i.orbit === 'now')) return;
    setClearingNow(true);
    try {
      const next = await window.electronAPI.matter.clearNowOrbit();
      applySnapshot(next);
      setSelectedId((current) => {
        if (!current) return null;
        return next.items.some((i) => i.id === current) ? current : null;
      });
    } finally {
      setClearingNow(false);
    }
  };

  const openSettings = () => {
    setSettingsTab('matter');
    setShowSettings(true);
  };

  const lastScanLabel = snapshot.lastScan?.finishedAt
    ? `${Math.max(0, Math.round((Date.now() - snapshot.lastScan.finishedAt) / 60000))}m ago`
    : 'never';

  return (
    <div className="h-full min-h-0 flex flex-col bg-background overflow-hidden">
      <header className="shrink-0 border-b border-border-muted px-4 py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-text-primary tracking-tight">
              {t('matter.title')}
            </h1>
            <span className="text-[11px] text-text-muted truncate">
              {snapshot.profileSummary || t('matter.subtitle')}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusPill
              icon={<Activity className="w-3 h-3" />}
              label={snapshot.inScanWindow ? t('matter.statusActive') : t('matter.statusQuiet')}
            />
            <StatusPill
              icon={<Radio className="w-3 h-3" />}
              label={
                snapshot.scanning
                  ? t('matter.scanning')
                  : t('matter.lastScan', { when: lastScanLabel })
              }
            />
            <StatusPill
              icon={<Gauge className="w-3 h-3" />}
              label={t('matter.focusScore', { score: snapshot.focusScore })}
            />
            <StatusPill
              icon={<Plug className="w-3 h-3" />}
              label={t('matter.connectors', { count: snapshot.connectedCount })}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void scanNow()}
          disabled={!matterEnabled || busy || snapshot.scanning}
          className="h-9 px-3 rounded-xl border border-border-muted text-sm text-text-secondary hover:bg-surface-hover flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${snapshot.scanning || busy ? 'animate-spin' : ''}`} />
          {t('matter.scanNow')}
        </button>
        <button
          type="button"
          onClick={() => void clearNowOrbit()}
          disabled={clearingNow || !snapshot.items.some((i) => i.orbit === 'now')}
          className="h-9 w-9 rounded-xl border border-border-muted flex items-center justify-center text-text-secondary hover:bg-surface-hover disabled:opacity-50"
          title={t('matter.clearNow')}
        >
          <Clock3 className={`w-4 h-4 ${clearingNow ? 'animate-pulse' : ''}`} />
        </button>
        <button
          type="button"
          onClick={openSettings}
          className="h-9 w-9 rounded-xl border border-border-muted flex items-center justify-center text-text-secondary hover:bg-surface-hover"
          title={t('matter.settings')}
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-9 w-9 rounded-xl border border-border-muted flex items-center justify-center text-text-secondary hover:bg-surface-hover"
          title={t('common.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {!matterEnabled ? (
        <div className="shrink-0 mx-4 mt-3 rounded-xl border border-border-muted bg-surface/80 px-3 py-2 text-[12px] text-text-secondary">
          {t('matter.disabledBanner')}{' '}
          <button
            type="button"
            onClick={openSettings}
            className="text-accent underline underline-offset-2"
          >
            {t('matter.settings')}
          </button>
        </div>
      ) : null}

      {snapshot.morningBrief && snapshot.items.length > 0 ? (
        <div className="shrink-0 mx-4 mt-3 rounded-xl border border-accent/40 bg-accent-muted/25 px-4 py-3 text-sm text-text-primary">
          <span className="font-semibold text-accent mr-2">{briefLabel}</span>
          <span className="font-medium leading-snug">{snapshot.morningBrief}</span>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_280px] gap-0">
        <section className="min-h-0 border-r border-border-muted flex flex-col px-3 py-3">
          <div className="flex items-center gap-1 mb-3 rounded-lg border border-border-subtle p-0.5 bg-background/50">
            <button
              type="button"
              onClick={() => setLeftTab('signals')}
              className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                leftTab === 'signals'
                  ? 'bg-surface text-text-primary'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {t('matter.signals')}
              <span className="ml-1 text-[10px] opacity-70">{filteredItems.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setLeftTab('calendar')}
              className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                leftTab === 'calendar'
                  ? 'bg-surface text-text-primary'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {t('matter.calendarTab')}
              <span className="ml-1 text-[10px] opacity-70">{snapshot.meetings.length}</span>
            </button>
          </div>

          {leftTab === 'calendar' ? (
            <>
              <div className="flex items-center justify-between px-1 mb-2">
                <p className="text-[10px] text-text-muted">
                  {snapshot.meetingsFetching
                    ? t('matter.meetingsRefreshing')
                    : snapshot.meetingsLastFetch
                      ? t('matter.meetingsLastFetch', {
                          when: `${Math.max(
                            0,
                            Math.round((Date.now() - snapshot.meetingsLastFetch) / 60000)
                          )}m ago`,
                        })
                      : t('matter.meetingsNeverFetched')}
                </p>
                <button
                  type="button"
                  onClick={() => void refreshMeetings()}
                  disabled={!matterEnabled || snapshot.meetingsFetching}
                  className="text-[10px] font-semibold text-accent hover:underline disabled:opacity-50"
                >
                  {t('matter.meetingsRefresh')}
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                {!snapshot.settings.sources.calendar ? (
                  <p className="text-[12px] text-text-muted px-1 py-4">
                    {t('matter.meetingsSourceOff')}
                  </p>
                ) : snapshot.meetings.length === 0 ? (
                  <p className="text-[12px] text-text-muted px-1 py-4">
                    {t('matter.meetingsEmpty')}
                  </p>
                ) : (
                  snapshot.meetings.map((meeting) => (
                    <MatterMeetingCard
                      key={meeting.id}
                      meeting={meeting}
                      selected={selectedMeetingId === meeting.id}
                      onSelect={() => {
                        setSelectedMeetingId(meeting.id);
                        setSelectedId(null);
                      }}
                    />
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
              {filteredItems.length === 0 ? (
                <EmptySignals
                  connectedCount={snapshot.connectedCount}
                  onConnectors={() => {
                    setSettingsTab('connectors');
                    setShowSettings(true);
                  }}
                />
              ) : (
                filteredItems.map((item) => (
                  <MatterSignalCard
                    key={item.id}
                    item={item}
                    selected={selectedId === item.id}
                    onSelect={() => {
                      setSelectedId(item.id);
                      setSelectedMeetingId(null);
                    }}
                    onDone={() => void runAction(item, 'done')}
                    onDismiss={(mute) => void runAction(item, 'dismiss', mute)}
                    onSnooze={() => void runAction(item, 'snooze')}
                    onPin={() => void runAction(item, item.pinned ? 'unpin' : 'pin')}
                    onOpen={() => void runAction(item, 'open')}
                    onHandleChat={() => void openSignalChat(item)}
                  />
                ))
              )}
            </div>
          )}
        </section>

        <section className="min-h-0 flex flex-col items-center px-4 py-4 relative overflow-y-auto">
          <div
            className={`w-full flex flex-col items-center ${
              selectedItem || selectedMeeting ? 'shrink-0' : 'flex-1 justify-center'
            }`}
          >
            <div
              className={
                selectedItem || selectedMeeting ? 'w-full max-w-[280px]' : 'w-full max-w-[420px]'
              }
            >
              <MatterRadar
                items={snapshot.items}
                selectedId={selectedId}
                highlightedIds={filterActive ? highlightedIds : new Set()}
                pulse={snapshot.pulse}
                onSelect={(id) => {
                  setSelectedId(id);
                  setSelectedMeetingId(null);
                  setLeftTab('signals');
                }}
              />
            </div>
            <div
              className="mt-3 flex items-center gap-2 text-[11px] font-semibold tracking-wide"
              role="group"
              aria-label="Filter signals by severity"
            >
              {SEVERITY_FILTERS.map((sev) => {
                const selected = activeSeverity === sev.id;
                return (
                  <button
                    key={sev.id}
                    type="button"
                    onClick={() => setActiveSeverity(selected ? null : sev.id)}
                    aria-pressed={selected}
                    title={
                      selected
                        ? `Clear ${sev.label.toLowerCase()} filter`
                        : `Show ${sev.label.toLowerCase()} signals`
                    }
                    className={`rounded-lg px-2.5 py-1 transition-colors ${sev.className} ${
                      selected ? sev.activeClassName : ''
                    }`}
                  >
                    {snapshot[sev.countKey]} {sev.label}
                  </button>
                );
              })}
            </div>
          </div>

          {selectedMeeting ? (
            <div className="mt-4 w-full flex justify-center pb-2">
              <MatterMeetingDetail
                meeting={selectedMeeting}
                onClose={() => {
                  setSelectedMeetingId(null);
                  setOpenPrepFullscreen(false);
                }}
                onOpen={() => void openMeetingLink(selectedMeeting)}
                onPrep={() => void prepMeeting(selectedMeeting)}
                prepLoading={activePrepLoadingId === selectedMeeting.id}
                autoPrepFullscreen={openPrepFullscreen}
                onAutoPrepFullscreenConsumed={clearOpenPrepFullscreen}
              />
            </div>
          ) : selectedItem ? (
            <div className="mt-4 w-full flex justify-center pb-2">
              <MatterItemDetail
                item={selectedItem}
                onClose={() => setSelectedId(null)}
                onDone={() => void runAction(selectedItem, 'done')}
                onDismiss={(mute) => void runAction(selectedItem, 'dismiss', mute)}
                onSnooze={() => void runAction(selectedItem, 'snooze')}
                onPin={() => void runAction(selectedItem, selectedItem.pinned ? 'unpin' : 'pin')}
                onOpen={() => void runAction(selectedItem, 'open')}
                onHandleChat={() => void openSignalChat(selectedItem)}
              />
            </div>
          ) : null}
        </section>

        <section className="min-h-0 border-l border-border-muted px-3 py-3">
          <MatterLenses
            lenses={snapshot.lenses}
            activeLens={activeLens}
            highlightedLens={relatedLensId}
            onSelect={setActiveLens}
          />
        </section>
      </div>

      <MatterAskBar
        disabled={busy}
        onAsk={(prompt) =>
          void handleAsk(
            prompt,
            selectedId ? [selectedId] : snapshot.items.slice(0, 5).map((i) => i.id)
          )
        }
      />
    </div>
  );
}

function StatusPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface/60 px-2.5 py-1 text-[11px] text-text-secondary">
      {icon}
      {label}
    </span>
  );
}

function EmptySignals({
  connectedCount,
  onConnectors,
}: {
  connectedCount: number;
  onConnectors: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-dashed border-border-muted px-3 py-6 text-center">
      <p className="text-sm text-text-primary font-medium">{t('matter.emptyTitle')}</p>
      <p className="mt-1 text-[12px] text-text-muted">
        {connectedCount === 0 ? t('matter.emptyNoConnectors') : t('matter.emptyQuiet')}
      </p>
      {connectedCount === 0 ? (
        <button
          type="button"
          onClick={onConnectors}
          className="mt-3 text-[12px] font-medium text-accent hover:underline"
        >
          {t('matter.wireConnectors')}
        </button>
      ) : null}
    </div>
  );
}
