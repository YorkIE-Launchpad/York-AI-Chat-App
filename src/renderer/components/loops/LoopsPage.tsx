/**
 * Follow-ups (Loops) — commitments captured from meetings, Today, and quick-add.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlignLeft, CalendarClock, Plus, Settings, UserRound, Users, X } from 'lucide-react';
import { useAppStore } from '../../store';
import {
  DEFAULT_LOOPS_RUNTIME,
  loopDueBucket,
  parseLoopQuickAddDraft,
  type Loop,
  type LoopDueBucket,
  type LoopsRuntimeConfig,
  type LoopsSnapshot,
  type LoopUpdateInput,
} from '../../../shared/loops';
import { LoopRow } from './LoopRow';

type LoopsTab = 'mine' | 'waiting' | 'closed';

const BUCKET_ORDER: LoopDueBucket[] = ['overdue', 'today', 'week', 'later'];

const EMPTY_SNAPSHOT: LoopsSnapshot = {
  loops: [],
  dueCount: 0,
  settings: DEFAULT_LOOPS_RUNTIME,
};

interface LoopsPageProps {
  onClose: () => void;
}

export function LoopsPage({ onClose }: LoopsPageProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<LoopsSnapshot>(EMPTY_SNAPSHOT);
  const initialTab = useAppStore((s) => s.followUpsTab);
  const setFollowUpsTab = useAppStore((s) => s.setFollowUpsTab);
  const [tab, setTabState] = useState<LoopsTab>(initialTab);
  const setTab = (next: LoopsTab) => {
    setTabState(next);
    setFollowUpsTab(next);
  };
  const [draft, setDraft] = useState('');
  const [waitingDraft, setWaitingDraft] = useState(false);
  const [researchDraft, setResearchDraft] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capturePromptDraft, setCapturePromptDraft] = useState('');
  const setLoopsBadgeCount = useAppStore((s) => s.setLoopsBadgeCount);
  const openMatterToItem = useAppStore((s) => s.openMatterToItem);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  const apply = useCallback(
    (next: LoopsSnapshot) => {
      setSnapshot(next);
      setLoopsBadgeCount(next.dueCount);
    },
    [setLoopsBadgeCount]
  );

  useEffect(() => {
    const api = window.electronAPI?.loops;
    if (!api) return;
    let cancelled = false;
    void api
      .list()
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    const off = api.onChanged(apply);
    return () => {
      cancelled = true;
      off();
    };
  }, [apply]);

  const run = useCallback(
    async (op: () => Promise<LoopsSnapshot>) => {
      setError(null);
      try {
        apply(await op());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [apply]
  );

  const api = window.electronAPI?.loops;
  const update = (id: string, updates: LoopUpdateInput) =>
    api && void run(() => api.update(id, updates));

  const draftPreview = useMemo(
    () => (draft.trim() ? parseLoopQuickAddDraft(draft) : null),
    [draft]
  );

  const submitDraft = () => {
    if (!api) return;
    const { title, notes, dueAt } = parseLoopQuickAddDraft(draft);
    if (!title) return;
    setDraft('');
    void run(() =>
      api.create({
        title,
        notes,
        dueAt,
        owner: waitingDraft ? 'other' : 'me',
        research: researchDraft,
      })
    );
  };

  const openSource = (loop: Loop) => {
    if (loop.sourceRef.matterItemId) {
      openMatterToItem(loop.sourceRef.matterItemId);
      return;
    }
    if (loop.sourceRef.meetingId) {
      setSettingsTab('meetings');
      setShowSettings(true);
    }
  };

  useEffect(() => {
    setCapturePromptDraft(snapshot.settings.capturePrompt || '');
  }, [snapshot.settings.capturePrompt]);

  const saveSettings = async (partial: Partial<LoopsRuntimeConfig>) => {
    if (!api) return;
    try {
      const settings = await api.updateSettings(partial);
      setSnapshot((prev) => ({ ...prev, settings }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const { mine, waiting, closed } = useMemo(() => {
    const open = snapshot.loops.filter((l) => l.status === 'open');
    return {
      mine: open.filter((l) => l.owner === 'me'),
      waiting: open.filter((l) => l.owner === 'other'),
      closed: snapshot.loops.filter((l) => l.status !== 'open'),
    };
  }, [snapshot.loops]);

  const grouped = useMemo(() => {
    const now = Date.now();
    const groups = new Map<LoopDueBucket, Loop[]>();
    for (const loop of mine) {
      const bucket = loopDueBucket(loop.dueAt, now);
      groups.set(bucket, [...(groups.get(bucket) || []), loop]);
    }
    return BUCKET_ORDER.filter((b) => groups.has(b)).map((b) => ({
      bucket: b,
      loops: groups.get(b)!,
    }));
  }, [mine]);

  const rowProps = {
    onClose: (id: string) => api && void run(() => api.close(id)),
    onDrop: (id: string) => api && void run(() => api.drop(id)),
    onIgnore: (id: string) => update(id, { status: 'ignored' }),
    onSetOwner: (id: string, owner: 'me' | 'other') => update(id, { owner }),
    onReopen: (id: string) => update(id, { status: 'open' }),
    onRename: (id: string, title: string) => update(id, { title }),
    onSetNotes: (id: string, notes: string | null) => update(id, { notes }),
    onSetDue: (id: string, dueAt: number | null) => update(id, { dueAt }),
    onOpenSource: openSource,
    onResearch: (id: string) => api && void run(() => api.research(id)),
  };

  const tabs: Array<{ id: LoopsTab; label: string; count: number }> = [
    { id: 'mine', label: t('followUps.tabMine'), count: mine.length },
    { id: 'waiting', label: t('followUps.tabWaiting'), count: waiting.length },
    { id: 'closed', label: t('followUps.tabClosed'), count: closed.length },
  ];

  const visible = tab === 'waiting' ? waiting : tab === 'closed' ? closed : mine;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="relative flex shrink-0 items-center gap-3 px-6 pb-2 pt-7 md:px-9">
        <div className="mx-auto flex w-full max-w-[860px] items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em] text-text-primary">
              {t('followUps.title')}
            </h1>
            <p className="mt-1 text-[14px] text-text-secondary">{t('followUps.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              settingsOpen
                ? 'bg-accent-muted text-accent-text'
                : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
            }`}
            title={t('loops.settings')}
            aria-label={t('loops.settings')}
            aria-expanded={settingsOpen}
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
            title={t('common.close', { defaultValue: 'Close' })}
            aria-label={t('common.close', { defaultValue: 'Close' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {settingsOpen ? (
          <div className="absolute right-6 top-full z-20 mt-1 w-96 space-y-3 rounded-[14px] border border-border-subtle bg-surface-raised p-4 shadow-elevated md:right-9">
            <div className="text-[12px] font-semibold text-text-primary">
              {t('loops.settingsTitle')}
            </div>
            <label className="flex items-start gap-2 text-[12px] text-text-secondary">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                checked={snapshot.settings.captureFromMeetings}
                onChange={(e) => void saveSettings({ captureFromMeetings: e.target.checked })}
              />
              <span>{t('loops.captureFromMeetings')}</span>
            </label>
            <label className="flex items-start gap-2 text-[12px] text-text-secondary">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                checked={snapshot.settings.captureFromMatter}
                onChange={(e) => void saveSettings({ captureFromMatter: e.target.checked })}
              />
              <span>{t('loops.captureFromMatter')}</span>
            </label>
            <label className="block text-[12px] text-text-secondary">
              <span>
                {t('loops.matterThreshold', {
                  value: Math.round(snapshot.settings.matterConfidenceThreshold * 100),
                })}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                disabled={!snapshot.settings.captureFromMatter}
                value={Math.round(snapshot.settings.matterConfidenceThreshold * 100)}
                onChange={(e) =>
                  void saveSettings({ matterConfidenceThreshold: Number(e.target.value) / 100 })
                }
                className="mt-1 w-full accent-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-[12px] text-text-secondary">
              <span>{t('loops.capturePrompt')}</span>
              <textarea
                value={capturePromptDraft}
                onChange={(e) => setCapturePromptDraft(e.target.value)}
                onBlur={() => {
                  const next = capturePromptDraft.trim();
                  if (next === (snapshot.settings.capturePrompt || '')) return;
                  void saveSettings({ capturePrompt: next });
                }}
                rows={3}
                placeholder={t('loops.capturePromptPlaceholder')}
                className="mt-1 w-full resize-y rounded-lg border border-border-muted bg-transparent px-2 py-1.5 text-[12px] text-text-primary outline-none placeholder:text-text-muted"
              />
              <span className="mt-1 block text-[11px] text-text-muted">
                {t('loops.capturePromptHint')}
              </span>
            </label>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-4 md:px-9">
        <div className="mx-auto w-full max-w-[860px] space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitDraft();
            }}
            className="rounded-[14px] border border-border bg-surface px-3.5 py-3 transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/15"
          >
            <div className="flex items-start gap-2">
              <Plus className="mt-1.5 h-4 w-4 shrink-0 text-text-muted" />
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submitDraft();
                  }
                }}
                rows={Math.min(8, draft.split('\n').length)}
                placeholder={t('followUps.quickAddPlaceholder')}
                className="min-w-0 flex-1 resize-none bg-transparent py-1 text-[14px] leading-5 text-text-primary outline-none placeholder:text-text-muted"
              />
              <button
                type="submit"
                disabled={!draftPreview?.title}
                className="btn btn-sm btn-primary shrink-0"
              >
                {t('followUps.add')}
              </button>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-6 text-[12px] text-text-muted">
              {draftPreview?.title ? (
                <span className="inline-flex min-w-0 items-center gap-1.5 text-text-secondary">
                  {t('followUps.willAdd')}
                  <b className="max-w-[260px] truncate font-semibold text-text-primary">
                    {draftPreview.title}
                  </b>
                  <span className="meta-chip">
                    <CalendarClock className="h-3 w-3" />
                    {draftPreview.dueAt
                      ? new Date(draftPreview.dueAt).toLocaleDateString(undefined, {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })
                      : t('followUps.noDue')}
                  </span>
                  {draftPreview.notes ? (
                    <span className="meta-chip">
                      <AlignLeft className="h-3 w-3" />
                      {t('followUps.withNotes')}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span>{t('followUps.quickAddHint')}</span>
              )}
              <span className="ml-auto inline-flex rounded-md border border-border-subtle p-0.5">
                <button
                  type="button"
                  onClick={() => setWaitingDraft(false)}
                  aria-pressed={!waitingDraft}
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11.5px] font-medium ${
                    !waitingDraft ? 'bg-surface-hover text-text-primary' : 'text-text-muted'
                  }`}
                >
                  <UserRound className="h-3 w-3" />
                  {t('followUps.iOwe')}
                </button>
                <button
                  type="button"
                  onClick={() => setWaitingDraft(true)}
                  aria-pressed={waitingDraft}
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11.5px] font-medium ${
                    waitingDraft ? 'bg-surface-hover text-text-primary' : 'text-text-muted'
                  }`}
                >
                  <Users className="h-3 w-3" />
                  {t('followUps.waitingOn')}
                </button>
              </span>
              <label
                className="flex shrink-0 items-center gap-1.5 text-[11.5px]"
                title={t('loops.generateHint')}
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={researchDraft}
                  onChange={(e) => setResearchDraft(e.target.checked)}
                />
                {t('loops.generateOnAddToggle')}
              </label>
            </div>
          </form>

          {error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-500">
              {error}
            </div>
          ) : null}

          <div className="tab-row" role="tablist">
            {tabs.map((item) => (
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
          </div>

          {visible.length === 0 ? (
            <div className="rounded-[14px] border border-dashed border-border px-4 py-8 text-center text-[13px] text-text-muted">
              {tab === 'mine'
                ? t('loops.emptyMine')
                : tab === 'waiting'
                  ? t('loops.emptyWaiting')
                  : t('loops.emptyClosed')}
            </div>
          ) : tab === 'mine' ? (
            grouped.map((group) => (
              <section key={group.bucket} className="space-y-1.5">
                <h2
                  className={`mt-2 text-[11px] font-bold uppercase tracking-[0.05em] ${
                    group.bucket === 'overdue' ? 'text-error' : 'text-text-muted'
                  }`}
                >
                  {t(`loops.bucket.${group.bucket}`)}
                  <span className="ml-1 opacity-70">{group.loops.length}</span>
                </h2>
                {group.loops.map((loop) => (
                  <LoopRow key={loop.id} loop={loop} {...rowProps} />
                ))}
              </section>
            ))
          ) : (
            <div className="space-y-1.5">
              {visible.map((loop) => (
                <LoopRow key={loop.id} loop={loop} {...rowProps} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
