import { CalendarDays } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MEETING_PREP_MARKER, type MatterMeeting } from '../../../shared/matter';
import {
  calendarOrbitSeverity,
  formatDueRelative,
  formatMeetingWhen,
  isDueUrgent,
} from '../../../shared/matter-time';

interface MatterMeetingCardProps {
  meeting: MatterMeeting;
  selected: boolean;
  onSelect: () => void;
}

function meetingSubtitle(meeting: MatterMeeting): string {
  const when = formatMeetingWhen(meeting.startMs, meeting.endMs, meeting.when);
  // Drop a stale ISO/when prefix from summary; keep attendee trailing segment.
  const summary = (meeting.summary || '').trim();
  if (!summary) return when;
  if (!when) return summary;
  if (summary === meeting.when || summary.startsWith(meeting.when)) {
    const rest = summary.slice(meeting.when.length).replace(/^\s*·\s*/, '').trim();
    return rest ? `${when} · ${rest}` : when;
  }
  // Already friendly or custom
  if (/T\d{2}:\d{2}:\d{2}/.test(summary) || /\d{4}-\d{2}-\d{2}T/.test(summary)) {
    const attendee = summary.match(/\bw\/\s+.+$/i)?.[0];
    return attendee ? `${when} · ${attendee}` : when;
  }
  return summary;
}

export function MatterMeetingCard({ meeting, selected, onSelect }: MatterMeetingCardProps) {
  const { t } = useTranslation();
  const hasPrep = Boolean(meeting.rawDetails?.trim().startsWith(MEETING_PREP_MARKER));
  const { orbit } = calendarOrbitSeverity(meeting.startMs);
  const subtitle = meetingSubtitle(meeting);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
        selected
          ? 'border-accent/50 bg-accent/10'
          : 'border-border-subtle bg-surface/60 hover:bg-surface-hover'
      }`}
    >
      <div className="flex items-start gap-2">
        <CalendarDays className="w-3.5 h-3.5 mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[13px] font-semibold text-text-primary leading-snug line-clamp-2">
              {meeting.title || t('matter.meetingUntitled')}
            </p>
            {meeting.startMs != null ? (
              <span
                className={`shrink-0 text-[10px] font-semibold ${
                  isDueUrgent(meeting.startMs) ? 'text-red-400' : 'text-text-muted'
                }`}
              >
                {formatDueRelative(meeting.startMs)}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-text-secondary line-clamp-2">
            {subtitle}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <span className="rounded-md border border-border-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-muted">
              {orbit}
            </span>
            {hasPrep ? (
              <span className="rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                {t('matter.meetingPrepped')}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </button>
  );
}
