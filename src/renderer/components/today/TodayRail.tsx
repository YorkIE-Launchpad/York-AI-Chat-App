import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FileText, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { MEETING_PREP_MARKER, type MatterMeeting } from '../../../shared/matter';
import {
  formatMeetingWhen,
  formatNextUpRelative,
  isDueUrgent,
  pickNextUpMeeting,
} from '../../../shared/matter-time';
import type { Loop } from '../../../shared/loops';
import { useAppStore } from '../../store';
import { formatClock, relativeAgo } from './today-format';

interface TodayRailProps {
  meetings: MatterMeeting[];
  meetingsFetching: boolean;
  calendarEnabled: boolean;
  loops: Loop[];
  prepLoadingId: string | null;
  onPrep: (meeting: MatterMeeting) => void;
  onOpenMeeting: (meeting: MatterMeeting, options?: { prepFullscreen?: boolean }) => void;
  onJoin: (meeting: MatterMeeting) => void;
  onRefreshMeetings: () => void;
}

function prepExcerpt(raw: string | null): string | null {
  const text = raw?.trim();
  if (!text?.startsWith(MEETING_PREP_MARKER)) return null;
  const body = text
    .slice(MEETING_PREP_MARKER.length)
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return body ? (body.length > 220 ? `${body.slice(0, 217)}…` : body) : null;
}

function isToday(ms: number | null, now: number): boolean {
  if (!ms) return false;
  const a = new Date(ms);
  const b = new Date(now);
  return a.toDateString() === b.toDateString();
}

export function TodayRail({
  meetings,
  meetingsFetching,
  calendarEnabled,
  loops,
  prepLoadingId,
  onPrep,
  onOpenMeeting,
  onJoin,
  onRefreshMeetings,
}: TodayRailProps) {
  const { t } = useTranslation();
  const setShowLoops = useAppStore((s) => s.setShowLoops);
  const setFollowUpsTab = useAppStore((s) => s.setFollowUpsTab);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const next = useMemo(() => pickNextUpMeeting(meetings, now), [meetings, now]);
  const schedule = useMemo(
    () =>
      meetings
        .filter((m) => isToday(m.startMs, now))
        .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0)),
    [meetings, now]
  );
  const waiting = useMemo(
    () =>
      loops
        .filter((l) => l.status === 'open' && l.owner === 'other')
        .sort((a, b) => a.createdAt - b.createdAt),
    [loops]
  );

  const relative = next ? formatNextUpRelative(next.startMs, next.endMs, now) : '';
  const urgent = next?.startMs != null && relative !== 'now' && isDueUrgent(next.startMs, now);
  const excerpt = next ? prepExcerpt(next.rawDetails) : null;
  const prepLoading = Boolean(next && prepLoadingId === next.id);

  return (
    <aside className="space-y-3.5">
      <section className="rounded-[14px] border border-border-subtle bg-surface p-4">
        <div className="mb-2.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.05em] text-text-muted">
          {t('today.rail.nextUp')}
          {relative ? (
            <span
              className={`ml-auto normal-case tracking-normal ${
                urgent ? 'text-error' : relative === 'now' ? 'text-accent-text' : ''
              }`}
            >
              {relative}
            </span>
          ) : null}
        </div>
        {!calendarEnabled ? (
          <p className="text-[13px] text-text-muted">{t('today.rail.calendarOff')}</p>
        ) : !next ? (
          <p className="text-[13px] text-text-muted">{t('today.rail.noMeetings')}</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onOpenMeeting(next)}
              className="block w-full text-left"
            >
              <p className="mb-0.5 text-[16px] font-semibold leading-snug text-text-primary">
                {next.title || t('matter.meetingUntitled')}
              </p>
              <p className="text-[13px] font-semibold text-accent-text">
                {formatMeetingWhen(next.startMs, next.endMs, next.when)}
              </p>
            </button>
            {excerpt ? (
              <p className="my-2.5 border-l-2 border-accent pl-2.5 text-[12.5px] leading-[1.55] text-text-secondary">
                {excerpt}
              </p>
            ) : next.summary ? (
              <p className="my-2.5 line-clamp-3 text-[12.5px] leading-[1.55] text-text-secondary">
                {next.summary}
              </p>
            ) : (
              <div className="h-2.5" />
            )}
            <div className="flex items-center gap-1.5">
              {excerpt ? (
                <button
                  type="button"
                  onClick={() => onOpenMeeting(next, { prepFullscreen: true })}
                  className="btn btn-sm btn-primary"
                >
                  <FileText className="h-3.5 w-3.5" />
                  {t('today.rail.openPrep')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onPrep(next)}
                  disabled={prepLoading}
                  className="btn btn-sm btn-primary"
                >
                  {prepLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {prepLoading ? t('matter.action.prepping') : t('today.rail.prepMe')}
                </button>
              )}
              {next.htmlLink ? (
                <button
                  type="button"
                  onClick={() => onJoin(next)}
                  className="btn btn-sm btn-secondary"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('today.rail.openEvent')}
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>

      {calendarEnabled ? (
        <section className="rounded-[14px] border border-border-subtle bg-surface p-4">
          <div className="mb-2.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.05em] text-text-muted">
            {t('today.rail.schedule')}
            <button
              type="button"
              onClick={onRefreshMeetings}
              disabled={meetingsFetching}
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
              title={t('matter.meetingsRefresh')}
              aria-label={t('matter.meetingsRefresh')}
            >
              <RefreshCw className={`h-3 w-3 ${meetingsFetching ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {schedule.length === 0 ? (
            <p className="text-[13px] text-text-muted">{t('today.rail.scheduleEmpty')}</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {schedule.map((m) => {
                const past = m.endMs != null && m.endMs < now;
                const live = m.startMs != null && m.startMs <= now && (m.endMs ?? 0) >= now;
                return (
                  <li
                    key={m.id}
                    className={`grid grid-cols-[52px_minmax(0,1fr)] gap-2 border-t border-border-subtle py-[7px] text-[13px] first:border-t-0 ${
                      past ? 'opacity-50' : ''
                    }`}
                  >
                    <time
                      className={`tabular-nums ${live ? 'font-bold text-accent-text' : 'text-text-muted'}`}
                    >
                      {formatClock(m.startMs)}
                    </time>
                    <button
                      type="button"
                      onClick={() => onOpenMeeting(m)}
                      className="truncate text-left text-text-primary hover:underline"
                    >
                      {m.title || t('matter.meetingUntitled')}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <section className="rounded-[14px] border border-border-subtle bg-surface p-4">
        <div className="mb-2.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.05em] text-text-muted">
          {t('today.rail.waitingOn')}
          {waiting.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setFollowUpsTab('waiting');
                setShowLoops(true);
              }}
              className="ml-auto text-[11px] font-semibold normal-case tracking-normal text-accent-text hover:underline"
            >
              {t('today.rail.seeAll', { count: waiting.length })}
            </button>
          ) : null}
        </div>
        {waiting.length === 0 ? (
          <p className="text-[13px] text-text-muted">{t('today.rail.waitingEmpty')}</p>
        ) : (
          <ul className="m-0 list-none space-y-2.5 p-0">
            {waiting.slice(0, 4).map((loop) => (
              <li key={loop.id} className="text-[13px]">
                <p className="truncate font-medium text-text-primary">{loop.title}</p>
                <p className="text-[12px] text-text-muted">
                  {[loop.projectName, loop.counterpart, relativeAgo(t, loop.createdAt, now)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
