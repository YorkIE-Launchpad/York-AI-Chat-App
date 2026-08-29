import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Radio, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_MATTER_RUNTIME, type MatterItem, type MatterSnapshot } from '../../../shared/matter';
import { useAppStore } from '../../store';

function briefLabelKey(
  hour: number
): 'matter.morningBrief' | 'matter.afternoonBrief' | 'matter.eveningBrief' {
  if (hour < 12) return 'matter.morningBrief';
  if (hour < 17) return 'matter.afternoonBrief';
  return 'matter.eveningBrief';
}

const EMPTY_SNAPSHOT: Pick<
  MatterSnapshot,
  'items' | 'morningBrief' | 'pulse' | 'scanning' | 'settings' | 'criticalCount' | 'warningCount'
> = {
  items: [],
  morningBrief: null,
  pulse: '',
  scanning: false,
  settings: DEFAULT_MATTER_RUNTIME,
  criticalCount: 0,
  warningCount: 0,
};

function pickTopItems(items: MatterItem[], limit = 3): MatterItem[] {
  const rank = (item: MatterItem) => {
    if (item.severity === 'critical') return 0;
    if (item.severity === 'warning') return 1;
    return 2;
  };
  return [...items].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  healthy: 'bg-emerald-500',
  signal: 'bg-accent',
};

/**
 * Matter brief + top signals on the welcome screen (replaces connector quick-action chips).
 */
export function WelcomeMatterBriefing() {
  const { t } = useTranslation();
  const setShowMatter = useAppStore((s) => s.setShowMatter);
  const matterEnabled =
    useAppStore((s) => s.appConfig?.matterEnabled ?? s.appConfig?.matterRuntime?.enabled) !== false;
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);

  const applySnapshot = useCallback((next: MatterSnapshot) => {
    setSnapshot({
      items: next.items,
      morningBrief: next.morningBrief,
      pulse: next.pulse,
      scanning: next.scanning,
      settings: next.settings,
      criticalCount: next.criticalCount,
      warningCount: next.warningCount,
    });
  }, []);

  useEffect(() => {
    if (!matterEnabled || !window.electronAPI?.matter) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    let cancelled = false;
    void window.electronAPI.matter.getSnapshot().then((next) => {
      if (!cancelled) applySnapshot(next);
    });
    const off = window.electronAPI.matter.onUpdated((next) => {
      if (!cancelled) applySnapshot(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [matterEnabled, applySnapshot]);

  const briefLabel = t(briefLabelKey(new Date().getHours()));
  const topItems = useMemo(() => pickTopItems(snapshot.items), [snapshot.items]);
  const narrative =
    snapshot.morningBrief?.trim() ||
    snapshot.pulse?.trim() ||
    (snapshot.scanning ? t('welcome.matterBriefScanning') : t('matter.emptyQuiet'));

  if (!matterEnabled || !snapshot.settings.enabled) {
    return (
      <div className="rounded-2xl border border-border-subtle bg-background/65 px-4 py-3 text-center text-sm text-text-secondary">
        {t('welcome.matterBriefDisabled')}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-accent/30 bg-accent-muted/20 px-4 py-4 text-left space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-accent">
            <Radio className="w-3.5 h-3.5 shrink-0" />
            <span>{briefLabel}</span>
            {snapshot.scanning ? (
              <RefreshCw className="w-3 h-3 animate-spin text-text-muted" aria-hidden />
            ) : null}
          </div>
          <p className="text-sm font-medium leading-snug text-text-primary">{narrative}</p>
          {(snapshot.criticalCount > 0 || snapshot.warningCount > 0) && (
            <p className="text-[11px] text-text-muted">
              {snapshot.criticalCount > 0
                ? t('welcome.matterBriefCounts', {
                    critical: snapshot.criticalCount,
                    warning: snapshot.warningCount,
                  })
                : t('welcome.matterBriefWarnings', { count: snapshot.warningCount })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowMatter(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/35 bg-accent/10 px-3 py-1.5 text-[12px] font-semibold text-accent hover:bg-accent/15 transition-colors"
        >
          {t('welcome.matterBriefOpen')}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {topItems.length > 0 ? (
        <ul className="space-y-1.5 border-t border-border-subtle/80 pt-3">
          {topItems.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setShowMatter(true)}
                className="flex w-full items-start gap-2 rounded-lg px-1 py-1 text-left hover:bg-surface-hover/60 transition-colors"
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[item.severity] || SEVERITY_DOT.signal}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-text-primary leading-snug line-clamp-1">
                    {item.title}
                  </span>
                  {item.summary ? (
                    <span className="block text-[11px] text-text-muted line-clamp-1">{item.summary}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
