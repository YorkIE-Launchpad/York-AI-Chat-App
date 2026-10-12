import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock3, Filter, Gauge, Loader2, RefreshCw, Settings, Sparkles, X } from 'lucide-react';
import type {
  MatterItem,
  MatterLensId,
  MatterMeeting,
  MatterOrbit,
  MatterSeverity,
} from '../../../shared/matter';
import { MEETING_PREP_MARKER, relatedMatterLensId } from '../../../shared/matter';
import { formatMeetingWhen } from '../../../shared/matter-time';
import { useAppStore } from '../../store';
import { MatterItemDetail } from '../matter/MatterItemDetail';
import { MatterMeetingDetail } from '../matter/MatterMeetingDetail';
import { MatterOpportunityDetail } from '../matter/MatterOpportunityDetail';
import { MatterOpportunityList } from '../matter/MatterOpportunityList';
import { Menu, type MenuEntry } from '../ui/Menu';
import { TodayItemRow } from './TodayItemRow';
import { TodayRadar } from './TodayRadar';
import { TodayRail } from './TodayRail';
import { relativeAgo } from './today-format';
import type { MatterToday } from './useMatterToday';

type TodayTab = 'needs' | 'meetings' | 'opportunities';
type SeverityFilter = Extract<MatterSeverity, 'critical' | 'warning' | 'healthy'>;

const ORBITS: MatterOrbit[] = ['now', 'today', 'week', 'watching'];

type Drawer =
  | { kind: 'item'; id: string }
  | { kind: 'meeting'; id: string; prepFullscreen?: boolean }
  | { kind: 'opportunity'; id: string };

interface TodayBoardProps {
  matter: MatterToday;
  /** Greeting, brief, composer and suggestions — rendered left of the radar. */
  hero: ReactNode;
}

export function TodayBoard({ matter, hero }: TodayBoardProps) {
  const { t } = useTranslation();
  const { snapshot } = matter;
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const matterFocusItemId = useAppStore((s) => s.matterFocusItemId);
  const matterFocusMeetingId = useAppStore((s) => s.matterFocusMeetingId);
  const matterFocusPrepFullscreen = useAppStore((s) => s.matterFocusPrepFullscreen);
  const setMatterFocusItemId = useAppStore((s) => s.setMatterFocusItemId);
  const setMatterFocusMeetingId = useAppStore((s) => s.setMatterFocusMeetingId);

  const [tab, setTab] = useState<TodayTab>('needs');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [lens, setLens] = useState<MatterLensId | null>(null);
  const [severity, setSeverity] = useState<SeverityFilter | null>(null);
  const [rankingOpen, setRankingOpen] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const filteredItems = useMemo(() => {
    let items = snapshot.items;
    if (lens) {
      const ids = new Set(snapshot.lenses.find((l) => l.id === lens)?.itemIds ?? []);
      items = items.filter((i) => ids.has(i.id));
    }
    if (severity) items = items.filter((i) => i.severity === severity);
    return items;
  }, [snapshot.items, snapshot.lenses, lens, severity]);

  const filterActive = Boolean(lens || severity);
  const highlightedIds = useMemo(
    () => (filterActive ? new Set(filteredItems.map((i) => i.id)) : null),
    [filterActive, filteredItems]
  );

  const groups = useMemo(
    () =>
      ORBITS.map((orbit) => ({
        orbit,
        items: filteredItems.filter((i) => i.orbit === orbit),
      })).filter((g) => g.items.length > 0),
    [filteredItems]
  );

  const jumpToItem = useCallback((id: string) => {
    setTab('needs');
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(id);
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(null);
      requestAnimationFrame(() => setFlashId(id));
    });
  }, []);

  useEffect(() => {
    if (!flashId) return;
    const timer = window.setTimeout(() => setFlashId(null), 1300);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  // Deep links / notifications / Follow-ups "open source" land here.
  useEffect(() => {
    if (!matterFocusItemId) return;
    if (snapshot.items.some((i) => i.id === matterFocusItemId)) {
      setDrawer({ kind: 'item', id: matterFocusItemId });
      jumpToItem(matterFocusItemId);
      setMatterFocusItemId(null);
      return;
    }
    if (snapshot.items.length === 0 && snapshot.scanning) return;
    if (matter.loaded) setMatterFocusItemId(null);
  }, [
    jumpToItem,
    matter.loaded,
    matterFocusItemId,
    setMatterFocusItemId,
    snapshot.items,
    snapshot.scanning,
  ]);

  useEffect(() => {
    if (!matterFocusMeetingId) return;
    if (snapshot.meetings.some((m) => m.id === matterFocusMeetingId)) {
      setTab('meetings');
      setDrawer({
        kind: 'meeting',
        id: matterFocusMeetingId,
        prepFullscreen: matterFocusPrepFullscreen,
      });
      setMatterFocusMeetingId(null);
      return;
    }
    if (snapshot.meetingsLastFetch == null && snapshot.meetings.length === 0) return;
    setTab('meetings');
    setMatterFocusMeetingId(null);
  }, [
    matterFocusMeetingId,
    matterFocusPrepFullscreen,
    setMatterFocusMeetingId,
    snapshot.meetings,
    snapshot.meetingsLastFetch,
  ]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  const drawerItem =
    drawer?.kind === 'item' ? (snapshot.items.find((i) => i.id === drawer.id) ?? null) : null;
  const hoveredItem = hoveredId ? (snapshot.items.find((i) => i.id === hoveredId) ?? null) : null;
  const relatedLensId = relatedMatterLensId(drawerItem ?? hoveredItem, snapshot.lenses);
  const drawerMeeting =
    drawer?.kind === 'meeting' ? (snapshot.meetings.find((m) => m.id === drawer.id) ?? null) : null;
  const drawerOpportunity =
    drawer?.kind === 'opportunity'
      ? (snapshot.opportunities.find((o) => o.id === drawer.id) ?? null)
      : null;

  useEffect(() => {
    if (drawer && !drawerItem && !drawerMeeting && !drawerOpportunity) setDrawer(null);
  }, [drawer, drawerItem, drawerMeeting, drawerOpportunity]);

  const openSettings = (tabId: string) => {
    setSettingsTab(tabId);
    setShowSettings(true);
  };

  const act = (item: MatterItem, action: Parameters<MatterToday['runAction']>[1], mute?: boolean) =>
    void matter.runAction(item, action, mute);

  const severityFilters: Array<{ id: SeverityFilter; count: number; className: string }> = [
    { id: 'critical', count: snapshot.criticalCount, className: 'text-error' },
    { id: 'warning', count: snapshot.warningCount, className: 'text-warning' },
    { id: 'healthy', count: snapshot.healthyCount, className: 'text-accent-text' },
  ];

  const filterMenu: MenuEntry[] = [
    {
      id: 'all',
      label: t('today.filter.all'),
      onSelect: () => {
        setLens(null);
        setSeverity(null);
      },
    },
    'separator',
    ...severityFilters.map((f) => ({
      id: `sev-${f.id}`,
      label: `${t(`today.severity.${f.id}`)} · ${f.count}`,
      icon: <span className={`h-2 w-2 rounded-full bg-current ${f.className}`} />,
      onSelect: () => setSeverity((cur) => (cur === f.id ? null : f.id)),
    })),
    ...(snapshot.lenses.length
      ? (['separator'] as MenuEntry[]).concat(
          snapshot.lenses.map((l) => ({
            id: `lens-${l.id}`,
            label: `${l.label} · ${l.count}`,
            onSelect: () => setLens((cur) => (cur === l.id ? null : l.id)),
          }))
        )
      : []),
  ];

  const activeFilterLabel = [
    severity ? t(`today.severity.${severity}`) : null,
    lens ? snapshot.lenses.find((l) => l.id === lens)?.label : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const nowCount = snapshot.items.filter((i) => i.orbit === 'now').length;

  return (
    <>
      <div className="grid grid-cols-1 items-center gap-7 lg:grid-cols-[minmax(340px,1fr)_300px]">
        <div className="min-w-0">{hero}</div>
        {matter.enabled ? (
          <TodayRadar
            items={snapshot.items}
            scanning={snapshot.scanning}
            hoveredId={hoveredId}
            highlightedIds={highlightedIds}
            onHover={setHoveredId}
            onSelect={jumpToItem}
          />
        ) : null}
      </div>

      {!matter.enabled ? (
        <div className="mt-8 rounded-[14px] border border-dashed border-border px-5 py-6 text-center">
          <p className="text-[14px] font-semibold text-text-primary">{t('today.disabledTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-text-muted">
            {t('today.disabledBody')}
          </p>
          <button
            type="button"
            onClick={() => openSettings('matter')}
            className="btn btn-sm btn-secondary mt-3"
          >
            {t('today.disabledCta')}
          </button>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-7 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            <div className="tab-row mb-1.5" role="tablist">
              {(
                [
                  { id: 'needs', label: t('today.tabs.needs'), count: filteredItems.length },
                  {
                    id: 'meetings',
                    label: t('today.tabs.meetings'),
                    count: snapshot.meetings.length,
                  },
                  {
                    id: 'opportunities',
                    label: t('today.tabs.opportunities'),
                    count: snapshot.opportunities.length,
                  },
                ] as Array<{ id: TodayTab; label: string; count: number }>
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  onClick={() => setTab(item.id)}
                  className="tab-row-item"
                >
                  {item.label}
                  <span className="text-[11px] font-semibold text-text-muted">{item.count}</span>
                </button>
              ))}
              <div className="ml-auto flex items-center gap-1 pb-1">
                {tab === 'needs' ? (
                  <>
                    {filterActive ? (
                      <button
                        type="button"
                        onClick={() => {
                          setLens(null);
                          setSeverity(null);
                        }}
                        className="meta-chip hover:text-text-primary"
                        title={t('today.filter.clear')}
                      >
                        {activeFilterLabel}
                        <X className="h-3 w-3" />
                      </button>
                    ) : null}
                    <Menu
                      items={filterMenu}
                      trigger={({ toggle, open }) => (
                        <IconButton
                          onClick={toggle}
                          active={open || filterActive}
                          label={t('today.filter.label')}
                        >
                          <Filter className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
                    />
                    <IconButton
                      onClick={() => setRankingOpen((v) => !v)}
                      active={rankingOpen}
                      label={t('today.ranking.button')}
                    >
                      <Gauge className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      onClick={() => void matter.clearNowOrbit()}
                      disabled={matter.clearingNow || nowCount === 0}
                      label={t('today.clearNow')}
                    >
                      <Clock3
                        className={`h-3.5 w-3.5 ${matter.clearingNow ? 'animate-pulse' : ''}`}
                      />
                    </IconButton>
                  </>
                ) : null}
                <IconButton
                  onClick={() => void matter.scanNow()}
                  disabled={matter.busy || snapshot.scanning}
                  label={snapshot.scanning ? t('today.checking') : t('today.checkNow')}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${snapshot.scanning || matter.busy ? 'animate-spin' : ''}`}
                  />
                </IconButton>
                <IconButton onClick={() => openSettings('matter')} label={t('today.settings')}>
                  <Settings className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            </div>

            {rankingOpen && tab === 'needs' ? (
              <RankingPanel
                focusScore={snapshot.focusScore}
                lenses={snapshot.lenses}
                activeLens={lens}
                highlightedLens={relatedLensId}
                onLens={(id) => setLens((cur) => (cur === id ? null : id))}
                onClose={() => setRankingOpen(false)}
              />
            ) : null}

            {tab === 'needs' ? (
              groups.length === 0 ? (
                <EmptyNeeds
                  scanning={snapshot.scanning}
                  connectedCount={snapshot.connectedCount}
                  filterActive={filterActive}
                  onConnect={() => openSettings('connectors')}
                />
              ) : (
                groups.map((group) => (
                  <section key={group.orbit}>
                    <h3
                      className={`mb-1.5 mt-[18px] flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.05em] ${
                        group.orbit === 'now' ? 'text-error' : 'text-text-muted'
                      }`}
                    >
                      {t(`today.orbit.${group.orbit}`)}
                      <span className="font-semibold opacity-70">{group.items.length}</span>
                    </h3>
                    {group.items.map((item) => (
                      <TodayItemRow
                        key={item.id}
                        ref={(el) => {
                          if (el) rowRefs.current.set(item.id, el);
                          else rowRefs.current.delete(item.id);
                        }}
                        item={item}
                        highlighted={hoveredId === item.id || flashId === item.id}
                        tracked={matter.isTracked(item)}
                        onHover={setHoveredId}
                        onOpenDetail={() => setDrawer({ kind: 'item', id: item.id })}
                        onHandleChat={() => void matter.openItemChat(item)}
                        onSnooze={() => act(item, 'snooze')}
                        onDone={() => act(item, 'done')}
                        onDismiss={(mute) => act(item, 'dismiss', mute)}
                        onPin={() => act(item, item.pinned ? 'unpin' : 'pin')}
                        onOpenSource={() => act(item, 'open')}
                        onAddToFollowUps={
                          matter.addToFollowUps ? () => matter.addToFollowUps?.(item) : undefined
                        }
                      />
                    ))}
                  </section>
                ))
              )
            ) : tab === 'meetings' ? (
              <MeetingsPane
                meetings={snapshot.meetings}
                calendarEnabled={snapshot.settings.sources.calendar}
                fetching={snapshot.meetingsFetching}
                lastFetch={snapshot.meetingsLastFetch}
                prepLoadingId={matter.prepLoadingId}
                onRefresh={() => void matter.refreshMeetings()}
                onOpen={(m) => setDrawer({ kind: 'meeting', id: m.id })}
                onPrep={(m) => void matter.prepMeeting(m)}
                onOpenPrep={(m) => setDrawer({ kind: 'meeting', id: m.id, prepFullscreen: true })}
              />
            ) : (
              <div className="pt-3">
                <MatterOpportunityList
                  opportunities={snapshot.opportunities}
                  enabled={snapshot.settings.opportunities.enabled}
                  selectedId={drawer?.kind === 'opportunity' ? drawer.id : null}
                  onSelect={(id) => setDrawer({ kind: 'opportunity', id })}
                />
              </div>
            )}
          </div>

          <TodayRail
            meetings={snapshot.meetings}
            meetingsFetching={snapshot.meetingsFetching}
            calendarEnabled={snapshot.settings.sources.calendar}
            loops={matter.loops}
            prepLoadingId={matter.prepLoadingId}
            onPrep={(m) => void matter.prepMeeting(m)}
            onOpenMeeting={(m, options) =>
              setDrawer({ kind: 'meeting', id: m.id, prepFullscreen: options?.prepFullscreen })
            }
            onJoin={(m) => void matter.openMeetingLink(m)}
            onRefreshMeetings={() => void matter.refreshMeetings()}
          />
        </div>
      )}

      {drawer && (drawerItem || drawerMeeting || drawerOpportunity) ? (
        <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/30 animate-fade-in"
            aria-label={t('common.close')}
            onClick={() => setDrawer(null)}
          />
          <div className="relative h-full w-full max-w-[460px] overflow-y-auto border-l border-border-subtle bg-background-secondary p-4 shadow-elevated animate-slide-up">
            {drawerItem ? (
              <MatterItemDetail
                item={drawerItem}
                onClose={() => setDrawer(null)}
                onDone={() => act(drawerItem, 'done')}
                onDismiss={(mute) => act(drawerItem, 'dismiss', mute)}
                onSnooze={() => act(drawerItem, 'snooze')}
                onPin={() => act(drawerItem, drawerItem.pinned ? 'unpin' : 'pin')}
                onOpen={() => act(drawerItem, 'open')}
                onHandleChat={() => void matter.openItemChat(drawerItem)}
                tracked={matter.isTracked(drawerItem)}
                onAddToLoops={
                  matter.addToFollowUps ? () => matter.addToFollowUps?.(drawerItem) : undefined
                }
              />
            ) : drawerMeeting ? (
              <MatterMeetingDetail
                meeting={drawerMeeting}
                onClose={() => setDrawer(null)}
                onOpen={() => void matter.openMeetingLink(drawerMeeting)}
                onPrep={() => void matter.prepMeeting(drawerMeeting)}
                prepLoading={matter.prepLoadingId === drawerMeeting.id}
                autoPrepFullscreen={drawer.kind === 'meeting' && Boolean(drawer.prepFullscreen)}
                onAutoPrepFullscreenConsumed={() =>
                  setDrawer((d) => (d?.kind === 'meeting' ? { ...d, prepFullscreen: false } : d))
                }
              />
            ) : drawerOpportunity ? (
              <MatterOpportunityDetail
                opportunity={drawerOpportunity}
                onClose={() => setDrawer(null)}
                onDismiss={() => {
                  void matter.runOpportunityAction(drawerOpportunity, 'dismiss');
                  setDrawer(null);
                }}
                onSnooze={() => {
                  void matter.runOpportunityAction(drawerOpportunity, 'snooze');
                  setDrawer(null);
                }}
                onOpen={() => void matter.openOpportunitySource(drawerOpportunity)}
                onChat={() => void matter.openOpportunityChat(drawerOpportunity)}
                onReported={(next) => {
                  matter.applySnapshot(next);
                  setDrawer(null);
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
  active,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
        active
          ? 'bg-accent-muted text-accent-text'
          : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

function RankingPanel({
  focusScore,
  lenses,
  activeLens,
  highlightedLens,
  onLens,
  onClose,
}: {
  focusScore: number;
  lenses: MatterToday['snapshot']['lenses'];
  activeLens: MatterLensId | null;
  /** Lens related to the selected or hovered item; highlighted without filtering. */
  highlightedLens: MatterLensId | null;
  onLens: (id: MatterLensId) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 mt-3 rounded-[14px] border border-border-subtle bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-text-primary">{t('today.ranking.title')}</p>
          <p className="mt-1 text-[12.5px] leading-[1.55] text-text-secondary">
            {t('today.ranking.body')}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[22px] font-semibold leading-none text-text-primary tabular-nums">
            {focusScore}
          </div>
          <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('today.ranking.focusScore')}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover"
          aria-label={t('common.close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {lenses.length ? (
        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {lenses.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => onLens(l.id)}
              aria-pressed={activeLens === l.id}
              data-highlighted={highlightedLens === l.id ? 'true' : 'false'}
              className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                activeLens === l.id
                  ? 'border-accent/50 bg-accent-muted'
                  : highlightedLens === l.id
                    ? 'matter-focus-lens-related bg-accent/15'
                    : 'border-border-subtle hover:bg-surface-hover'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-semibold text-text-primary">{l.label}</span>
                <span className="text-[11px] text-text-muted">{l.count}</span>
                <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                  {t(`today.lensStatus.${l.status}`)}
                </span>
              </div>
              {l.summary ? (
                <p className="mt-0.5 line-clamp-2 text-[11.5px] text-text-secondary">{l.summary}</p>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmptyNeeds({
  scanning,
  connectedCount,
  filterActive,
  onConnect,
}: {
  scanning: boolean;
  connectedCount: number;
  filterActive: boolean;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 rounded-[14px] border border-dashed border-border px-5 py-8 text-center">
      {scanning ? (
        <p className="inline-flex items-center gap-2 text-[13px] text-text-secondary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('today.empty.scanning')}
        </p>
      ) : filterActive ? (
        <p className="text-[13px] text-text-secondary">{t('today.empty.filtered')}</p>
      ) : connectedCount === 0 ? (
        <>
          <p className="text-[14px] font-semibold text-text-primary">
            {t('today.empty.noAppsTitle')}
          </p>
          <p className="mt-1 text-[13px] text-text-muted">{t('today.empty.noAppsBody')}</p>
          <button type="button" onClick={onConnect} className="btn btn-sm btn-secondary mt-3">
            {t('today.empty.connect')}
          </button>
        </>
      ) : (
        <>
          <p className="text-[14px] font-semibold text-text-primary">
            {t('today.empty.clearTitle')}
          </p>
          <p className="mt-1 text-[13px] text-text-muted">{t('today.empty.clearBody')}</p>
        </>
      )}
    </div>
  );
}

function MeetingsPane({
  meetings,
  calendarEnabled,
  fetching,
  lastFetch,
  prepLoadingId,
  onRefresh,
  onOpen,
  onPrep,
  onOpenPrep,
}: {
  meetings: MatterMeeting[];
  calendarEnabled: boolean;
  fetching: boolean;
  lastFetch: number | null;
  prepLoadingId: string | null;
  onRefresh: () => void;
  onOpen: (m: MatterMeeting) => void;
  onPrep: (m: MatterMeeting) => void;
  onOpenPrep: (m: MatterMeeting) => void;
}) {
  const { t } = useTranslation();
  if (!calendarEnabled) {
    return <p className="py-6 text-[13px] text-text-muted">{t('matter.meetingsSourceOff')}</p>;
  }
  return (
    <div>
      <div className="flex items-center justify-between py-2 text-[12px] text-text-muted">
        <span>
          {fetching
            ? t('matter.meetingsRefreshing')
            : t('today.meetingsChecked', { when: relativeAgo(t, lastFetch) })}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={fetching}
          className="font-semibold text-accent-text hover:underline disabled:opacity-50"
        >
          {t('matter.meetingsRefresh')}
        </button>
      </div>
      {meetings.length === 0 ? (
        <p className="py-6 text-[13px] text-text-muted">{t('matter.meetingsEmpty')}</p>
      ) : (
        meetings.map((m) => {
          const hasPrep = Boolean(m.rawDetails?.trim().startsWith(MEETING_PREP_MARKER));
          const loading = prepLoadingId === m.id;
          return (
            <div
              key={m.id}
              onClick={() => onOpen(m)}
              className="group -mx-3 grid cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3 rounded-[10px] p-3 hover:bg-surface"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-[#1a73e8] text-[11px] font-extrabold text-white">
                C
              </div>
              <div className="min-w-0">
                <h4 className="mb-[3px] mt-px truncate text-[14px] font-semibold text-text-primary">
                  {m.title || t('matter.meetingUntitled')}
                </h4>
                <p className="text-[13px] text-accent-text">
                  {formatMeetingWhen(m.startMs, m.endMs, m.when)}
                </p>
                {m.summary ? (
                  <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.5] text-text-secondary">
                    {m.summary}
                  </p>
                ) : null}
              </div>
              <div
                className="flex items-center gap-1.5 opacity-60 transition-opacity group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                {hasPrep ? (
                  <button
                    type="button"
                    onClick={() => onOpenPrep(m)}
                    className="btn btn-sm btn-secondary"
                  >
                    {t('today.rail.openPrep')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onPrep(m)}
                    disabled={loading}
                    className="btn btn-sm btn-secondary"
                  >
                    {loading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {loading ? t('matter.action.prepping') : t('today.rail.prepMe')}
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
