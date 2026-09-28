import type { MeetingKind } from './types';

export interface RecurrenceInfo {
  recurring: boolean;
  seriesId: string | null;
  rrule: string | null;
  cadence: string | null;
}

/** Google instance ids are `<seriesId>_<YYYYMMDD>[THHMMSSZ]`. */
const INSTANCE_SUFFIX_RE = /_(\d{8}(?:T\d{6}Z?)?)$/;

export function seriesIdFromEventId(eventId: string | null | undefined): string | null {
  const id = eventId?.trim();
  if (!id) return null;
  return INSTANCE_SUFFIX_RE.test(id) ? id.replace(INSTANCE_SUFFIX_RE, '') : null;
}

export function isSameSeries(eventId: string, seriesId: string): boolean {
  return eventId === seriesId || eventId.startsWith(`${seriesId}_`);
}

export function normalizeSeriesTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cadenceFromRrule(rrule: string | null): string | null {
  if (!rrule) return null;
  const freq = rrule.match(/FREQ=(\w+)/i)?.[1]?.toUpperCase();
  const interval = Number.parseInt(rrule.match(/INTERVAL=(\d+)/i)?.[1] || '1', 10);
  switch (freq) {
    case 'DAILY':
      return interval > 1 ? `every ${interval} days` : 'daily';
    case 'WEEKLY':
      if (interval === 2) return 'biweekly';
      return interval > 1 ? `every ${interval} weeks` : 'weekly';
    case 'MONTHLY':
      return interval > 1 ? `every ${interval} months` : 'monthly';
    case 'YEARLY':
      return 'yearly';
    default:
      return null;
  }
}

/** Read recurrence markers the Calendar connector adds to `get_event` bodies. */
export function detectRecurrence(inviteBody: string, eventId?: string | null): RecurrenceInfo {
  const body = inviteBody || '';
  const seriesLine = body.match(/RecurringEventId:\s*(\S+)/i)?.[1] || null;
  const rrule = body.match(/RRULE:[^\n]+/i)?.[0]?.trim() || null;
  const seriesId = seriesLine || seriesIdFromEventId(eventId);
  return {
    recurring: Boolean(seriesId || rrule),
    seriesId: seriesId || (rrule && eventId ? eventId : null),
    rrule,
    cadence: cadenceFromRrule(rrule),
  };
}

export interface MeetingClassification {
  kind: MeetingKind;
  seriesId: string | null;
  cadence: string | null;
  reason: 'rrule' | 'series_id' | 'repeated_title' | 'none';
}

/**
 * Recurring when the calendar says so, or when the same title already ran
 * at least twice in the lookback window (ad-hoc series without an RRULE).
 */
export function classifyMeeting(input: {
  inviteBody: string;
  eventId?: string | null;
  pastSameTitleCount: number;
}): MeetingClassification {
  const info = detectRecurrence(input.inviteBody, input.eventId);
  if (info.recurring) {
    return {
      kind: 'recurring',
      seriesId: info.seriesId,
      cadence: info.cadence,
      reason: info.rrule ? 'rrule' : 'series_id',
    };
  }
  if (input.pastSameTitleCount >= 2) {
    return { kind: 'recurring', seriesId: null, cadence: null, reason: 'repeated_title' };
  }
  return { kind: 'one_off', seriesId: null, cadence: null, reason: 'none' };
}
