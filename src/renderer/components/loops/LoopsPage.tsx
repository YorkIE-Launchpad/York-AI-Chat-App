/**
 * Loops — persistent commitments captured from meetings, Matter, and quick-add.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleDashed, Plus, Settings, X } from 'lucide-react';
import { useAppStore } from '../../store';
import {
  DEFAULT_LOOPS_RUNTIME,
  loopDueBucket,
  parseLoopQuickAdd,
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
  const [tab, setTab] = useState<LoopsTab>('mine');
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

  const submitDraft = () => {
    if (!api) return;
    const { title, dueAt } = parseLoopQuickAdd(draft);
    if (!title) return;
    setDraft('');
    void run(() =>
      api.create({
        title,
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
    onSetDue: (id: string, dueAt: number | null) => update(id, { dueAt }),
    onOpenSource: openSource,
    onResearch: (id: string) => api && void run(() => api.research(id)),
  };

  const tabs: Array<{ id: LoopsTab; label: string; count: number }> = [
    { id: 'mine', label: t('loops.tabMine'), count: mine.length },
    { id: 'waiting', label: t('loops.tabWaiting'), count: waiting.length },
    { id: 'closed', label: t('loops.tabClosed'), count: closed.length },
  ];

  const visible = tab === 'waiting' ? waiting : tab === 'closed' ? closed : mine;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="relative flex shrink-0 items-center gap-3 border-b border-border-muted px-4 py-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-accent/12 text-accent">
          <CircleDashed className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight text-text-primary">
            {t('sidebar.loops')}
          </h1>
          <p className="truncate text-[12px] text-text-muted">{t('sidebar.loopsHint')}</p>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          className="h-9 w-9 rounded-xl border border-border-muted flex items-center justify-center text-text-secondary hover:bg-surface-hover"
          title={t('loops.settings')}
          aria-label={t('loops.settings')}
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          title={t('common.close', { defaultValue: 'Close' })}
          aria-label={t('common.close', { defaultValue: 'Close' })}
        >
          <X className="h-5 w-5" />
        </button>

        {settingsOpen ? (
          <div className="absolute right-4 top-full z-20 mt-2 w-96 rounded-xl border border-border-muted bg-surface p-3 shadow-lg space-y-3">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-[760px] space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitDraft();
            }}
            className="rounded-xl border border-border-muted bg-surface/60 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <Plus className="w-4 h-4 text-text-muted shrink-0" />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('loops.quickAddPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted"
              />
              <label className="flex items-center gap-1 text-[11px] text-text-muted shrink-0">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={waitingDraft}
                  onChange={(e) => setWaitingDraft(e.target.checked)}
                />
                {t('loops.waitingOnToggle')}
              </label>
              <label
                className="flex items-center gap-1 text-[11px] text-text-muted shrink-0"
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

          <div className="flex items-center gap-1 rounded-lg border border-border-subtle p-0.5 bg-background/50">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                  tab === item.id
                    ? 'bg-surface text-text-primary'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {item.label}
                <span className="ml-1 text-[10px] opacity-70">{item.count}</span>
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-muted px-4 py-8 text-center text-[12px] text-text-muted">
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
                  className={`text-[11px] font-semibold uppercase tracking-wide ${
                    group.bucket === 'overdue' ? 'text-red-500' : 'text-text-muted'
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
