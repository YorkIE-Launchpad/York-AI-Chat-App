import type { TFunction } from 'i18next';
import type { MatterItem, MatterSource } from '../../../shared/matter';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeAgo(t: TFunction, at: number | null | undefined, now = Date.now()): string {
  if (!at) return t('today.never');
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return t('today.justNow');
  if (diff < HOUR) return t('today.minutesAgo', { count: Math.round(diff / MINUTE) });
  if (diff < DAY) return t('today.hoursAgo', { count: Math.round(diff / HOUR) });
  return t('today.daysAgo', { count: Math.round(diff / DAY) });
}

/** Short due phrase for the row tag: "Overdue 2d", "Due in 3h", "Due today". */
export function dueLabel(t: TFunction, dueAt: number | null, now = Date.now()): string | null {
  if (!dueAt) return null;
  const diff = dueAt - now;
  if (diff < 0) {
    const late = -diff;
    if (late < HOUR)
      return t('today.due.overdueMinutes', { count: Math.max(1, Math.round(late / MINUTE)) });
    if (late < DAY) return t('today.due.overdueHours', { count: Math.round(late / HOUR) });
    return t('today.due.overdueDays', { count: Math.round(late / DAY) });
  }
  if (diff < HOUR)
    return t('today.due.inMinutes', { count: Math.max(1, Math.round(diff / MINUTE)) });
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  if (dueAt <= end.getTime()) return t('today.due.inHours', { count: Math.round(diff / HOUR) });
  return t('today.due.onDate', {
    date: new Date(dueAt).toLocaleDateString(undefined, { weekday: 'short' }),
  });
}

export const SOURCE_TILE: Record<MatterSource, { abbr: string; className: string }> = {
  gmail: { abbr: 'M', className: 'bg-[#c5221f] text-white' },
  slack: { abbr: 'S', className: 'bg-[#4a154b] text-white' },
  jira: { abbr: 'J', className: 'bg-[#0c66e4] text-white' },
  calendar: { abbr: 'C', className: 'bg-[#1a73e8] text-white' },
  meeting: { abbr: 'Z', className: 'bg-[#0b5cff] text-white' },
  drive: { abbr: 'D', className: 'bg-[#3c6e47] text-white' },
  hub: { abbr: 'H', className: 'bg-[#00876a] text-white' },
  launchpad: { abbr: 'L', className: 'bg-[#0f766e] text-white' },
  fused: { abbr: 'Y', className: 'bg-surface-raised text-accent-text' },
};

export function sourceName(t: TFunction, source: MatterSource): string {
  return t(`today.source.${source}`);
}

/** Primary row action label, phrased for what the user would actually do next. */
export function primaryActionLabel(t: TFunction, item: MatterItem): string {
  switch (item.source) {
    case 'gmail':
    case 'slack':
      return t('today.action.draftReply');
    case 'jira':
      return t('today.action.investigate');
    case 'calendar':
    case 'meeting':
      return t('today.action.prep');
    default:
      return t('today.action.helpMe');
  }
}

export function severityTagClass(severity: MatterItem['severity']): string {
  switch (severity) {
    case 'critical':
      return 'bg-error/15 text-error';
    case 'warning':
      return 'bg-warning/15 text-warning';
    case 'healthy':
      return 'bg-accent-muted text-accent-text';
    default:
      return 'bg-info/15 text-info';
  }
}

export function greetingKey(
  hour: number
): 'today.greeting.morning' | 'today.greeting.afternoon' | 'today.greeting.evening' {
  if (hour < 12) return 'today.greeting.morning';
  if (hour < 17) return 'today.greeting.afternoon';
  return 'today.greeting.evening';
}

export function formatClock(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
