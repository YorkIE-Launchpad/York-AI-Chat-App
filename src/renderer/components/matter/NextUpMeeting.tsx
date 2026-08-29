import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { CalendarDays, FileText, Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MEETING_PREP_MARKER,
  type MatterMeeting,
  type MatterSnapshot,
} from '../../../shared/matter';
import {
  formatMeetingWhen,
  formatNextUpRelative,
  isDueUrgent,
  pickNextUpMeeting,
} from '../../../shared/matter-time';
import { useAppStore } from '../../store';

/**
 * Persistent “next up” meeting chip for the sidebar (above workspace picker).
 */
export function NextUpMeeting() {
  const { t } = useTranslation();
  const matterEnabled =
    useAppStore((s) => s.appConfig?.matterEnabled ?? s.appConfig?.matterRuntime?.enabled) !==
    false;
  const openMatterToMeeting = useAppStore((s) => s.openMatterToMeeting);
  const matterPrepLoadingId = useAppStore((s) => s.matterPrepLoadingId);
  const setMatterPrepLoadingId = useAppStore((s) => s.setMatterPrepLoadingId);
  const [meetings, setMeetings] = useState<MatterMeeting[]>([]);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const applyMeetings = useCallback((snapshot: MatterSnapshot) => {
    if (!snapshot.settings.enabled) {
      setMeetings([]);
      return;
    }
    setMeetings(snapshot.meetings || []);
  }, []);

  useEffect(() => {
    if (!matterEnabled || !window.electronAPI?.matter) {
      setMeetings([]);
      return;
    }
    let cancelled = false;
    void window.electronAPI.matter.getSnapshot().then((snapshot) => {
      if (!cancelled) applyMeetings(snapshot);
    });
    const off = window.electronAPI.matter.onUpdated((snapshot) => {
      if (!cancelled) applyMeetings(snapshot);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [matterEnabled, applyMeetings]);

  useEffect(() => {
    if (!matterEnabled) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [matterEnabled]);

  const next = useMemo(() => pickNextUpMeeting(meetings, nowTick), [meetings, nowTick]);

  const hasPrep = Boolean(next?.rawDetails?.trim().startsWith(MEETING_PREP_MARKER));
  const prepLoading = Boolean(next && matterPrepLoadingId === next.id);
  const whenLine = next ? formatMeetingWhen(next.startMs, next.endMs, next.when) : '';
  const relative = next ? formatNextUpRelative(next.startMs, next.endMs, nowTick) : '';
  const urgent =
    next?.startMs != null && relative !== 'now' && isDueUrgent(next.startMs, nowTick);

  const handleOpen = () => {
    if (!next) return;
    openMatterToMeeting(next.id);
  };

  const handleSeeNote = (e: MouseEvent) => {
    e.stopPropagation();
    if (!next || prepLoading) return;
    openMatterToMeeting(next.id, { prepFullscreen: true });
  };

  const handlePrep = async (e: MouseEvent) => {
    e.stopPropagation();
    if (!next || !window.electronAPI?.matter?.prepMeeting || prepLoading) return;
    setMatterPrepLoadingId(next.id);
    try {
      const snapshot = await window.electronAPI.matter.prepMeeting(next.id);
      applyMeetings(snapshot);
      openMatterToMeeting(next.id, { prepFullscreen: true });
    } catch (error) {
      console.error('[Matter] Sidebar prep failed:', error);
    } finally {
      setMatterPrepLoadingId(null);
    }
  };

  if (!matterEnabled || !next) return null;

  return (
    <div className="space-y-1">
      <p className="px-0.5 text-[10px] font-medium tracking-[0.04em] text-text-muted">
        {t('matter.nextUp')}
      </p>
      <div className="rounded-lg border border-border-subtle bg-background/80 px-2 py-1.5">
        <button
          type="button"
          onClick={handleOpen}
          className="w-full min-w-0 text-left"
          title={t('matter.nextUpOpen')}
        >
          <div className="flex items-start gap-2">
            <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-text-primary">
                {next.title || t('matter.meetingUntitled')}
              </p>
              {whenLine ? (
                <p className="mt-0.5 line-clamp-1 text-[10px] text-text-secondary">{whenLine}</p>
              ) : null}
            </div>
            {relative ? (
              <span
                className={`shrink-0 text-[10px] font-semibold ${
                  urgent || relative.startsWith('overdue')
                    ? 'text-red-400'
                    : relative === 'now'
                      ? 'text-accent'
                      : 'text-text-muted'
                }`}
              >
                {relative}
              </span>
            ) : null}
          </div>
        </button>
        <div className="mt-1.5 flex items-center gap-1">
          {hasPrep ? (
            <>
              <button
                type="button"
                onClick={handleSeeNote}
                disabled={prepLoading}
                className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded-md border border-border-subtle bg-surface px-1.5 text-[10px] font-semibold text-text-primary hover:bg-surface-hover disabled:opacity-60"
                title={t('matter.action.seeNote')}
              >
                <FileText className="h-3 w-3" />
                {t('matter.action.seeNote')}
              </button>
              <button
                type="button"
                onClick={(e) => void handlePrep(e)}
                disabled={prepLoading}
                className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded-md border border-accent/35 bg-accent/10 px-1.5 text-[10px] font-semibold text-accent hover:bg-accent/15 disabled:opacity-60"
                title={t('matter.action.reprep')}
              >
                {prepLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {prepLoading ? t('matter.action.prepping') : t('matter.action.reprep')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={(e) => void handlePrep(e)}
              disabled={prepLoading}
              className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded-md border border-accent/35 bg-accent/10 px-1.5 text-[10px] font-semibold text-accent hover:bg-accent/15 disabled:opacity-60"
              title={t('matter.action.prepHint')}
            >
              {prepLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              {prepLoading ? t('matter.action.prepping') : t('matter.action.prep')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
