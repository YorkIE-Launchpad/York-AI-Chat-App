/**
 * Recurring-meeting history: past calendar occurrences, matching local
 * meeting notes, and the action items captured last time.
 */

import type { MeetingService } from '../../meetings/meeting-service';
import { DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID } from '../../../shared/mcp-defaults';
import { isSameSeries, normalizeSeriesTitle } from './classify';
import {
  envelopeBody,
  findToolName,
  isServerConnected,
  parseJsonLoose,
  safeCallTool,
} from './connectors';
import { isoDate, type GatherDeps } from './gather';
import type { CalendarInstance, PriorActionItem, SeriesHistory } from './types';

export const SERIES_LOOKBACK_DAYS = 90;

function toInstance(raw: unknown): CalendarInstance | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id : '';
  const start = typeof rec.start === 'string' ? rec.start : '';
  if (!id || !start) return null;
  return {
    id,
    title: typeof rec.title === 'string' ? rec.title : '',
    start,
    end: typeof rec.end === 'string' ? rec.end : undefined,
    htmlLink: typeof rec.htmlLink === 'string' ? rec.htmlLink : null,
    recurringEventId: typeof rec.recurringEventId === 'string' ? rec.recurringEventId : null,
  };
}

/** Parse Calendar `search_events` / `list_events` output (structured `events` or body lines). */
export function parseCalendarEvents(text: string): CalendarInstance[] {
  const json = parseJsonLoose(text);
  const events =
    json && typeof json === 'object' && Array.isArray((json as { events?: unknown }).events)
      ? (json as { events: unknown[] }).events
      : null;
  if (events) return events.map(toInstance).filter((e): e is CalendarInstance => Boolean(e));
  const out: CalendarInstance[] = [];
  for (const line of envelopeBody(text).split('\n')) {
    const m = line.trim().match(/^([^:\s]+):\s*(.*?)\s*\(([^)→]+)(?:→\s*([^)]+))?\)\s*$/);
    if (!m) continue;
    out.push({ id: m[1], title: m[2], start: m[3].trim(), end: m[4]?.trim() });
  }
  return out;
}

/** Keep earlier occurrences of the same series (or same title), newest first. */
export function filterSeriesInstances(
  events: CalendarInstance[],
  options: {
    seriesId: string | null;
    title: string;
    currentEventId: string | null;
    beforeMs: number;
  }
): CalendarInstance[] {
  const normTitle = normalizeSeriesTitle(options.title);
  return events
    .filter((e) => e.id !== options.currentEventId)
    .filter((e) => {
      const startMs = Date.parse(e.start);
      return Number.isFinite(startMs) && startMs < options.beforeMs;
    })
    .filter((e) => {
      if (options.seriesId) {
        return (
          isSameSeries(e.id, options.seriesId) ||
          (e.recurringEventId ? e.recurringEventId === options.seriesId : false)
        );
      }
      return normalizeSeriesTitle(e.title) === normTitle;
    })
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
}

export async function searchPastCalendarEvents(
  deps: GatherDeps,
  title: string,
  beforeIso: string
): Promise<CalendarInstance[]> {
  if (!isServerConnected(deps.mcp, DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID)) return [];
  const tool = findToolName(deps.mcp, DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID, ['search_events']);
  if (!tool || !title.trim()) return [];
  const timeMin = new Date(Date.parse(beforeIso) - SERIES_LOOKBACK_DAYS * 864e5).toISOString();
  const text = await safeCallTool(deps.mcp, tool, {
    query: title.trim().slice(0, 80),
    time_min: timeMin,
    time_max: beforeIso,
    limit: 25,
  });
  return text ? parseCalendarEvents(text) : [];
}

export interface LocalMeetingCandidate {
  id: string;
  title: string;
  startedAt: number;
  calendarEventId?: string | null;
}

/** Local recordings that belong to the series: calendar id first, then title/date. */
export function matchLocalSeriesMeetings<T extends LocalMeetingCandidate>(
  meetings: T[],
  options: { seriesId: string | null; title: string; instanceDates: Set<string>; beforeMs: number }
): T[] {
  const normTitle = normalizeSeriesTitle(options.title);
  return meetings
    .filter((m) => m.startedAt > 0 && m.startedAt < options.beforeMs)
    .filter((m) => {
      if (
        options.seriesId &&
        m.calendarEventId &&
        isSameSeries(m.calendarEventId, options.seriesId)
      ) {
        return true;
      }
      if (m.calendarEventId && options.seriesId) return false;
      const localTitle = normalizeSeriesTitle(m.title);
      if (localTitle === normTitle) return true;
      const date = isoDate(m.startedAt);
      if (!date || !options.instanceDates.has(date)) return false;
      const words = new Set(normTitle.split(' ').filter((w) => w.length >= 3));
      return localTitle.split(' ').some((w) => words.has(w));
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}

const OWNER_PATTERNS: RegExp[] = [
  /^\[([^\]]{2,40})\]\s*/,
  /^@?([A-Z][\w.'-]+(?:\s[A-Z][\w.'-]+)?)\s*:\s+/,
  /^@?([A-Z][\w.'-]+(?:\s[A-Z][\w.'-]+)?)\s+(?:to|will|should|owns|needs to)\s+/,
];

export function parseActionOwner(text: string): { owner?: string; text: string } {
  const trimmed = text.trim().replace(/^[-*•]\s*/, '');
  for (const re of OWNER_PATTERNS) {
    const m = trimmed.match(re);
    if (m?.[1]) return { owner: m[1].trim(), text: trimmed };
  }
  const trailing = trimmed.match(/\((?:owner:\s*)?@?([A-Z][\w.'-]+(?:\s[A-Z][\w.'-]+)?)\)\s*$/);
  if (trailing?.[1]) return { owner: trailing[1], text: trimmed };
  return { text: trimmed };
}

function inviteExcerpt(body: string): string {
  return envelopeBody(body)
    .split('\n')
    .filter(
      (l) => !/^(Link|Meet|Location|Attendees|RecurringEventId|Recurrence|RRULE):/i.test(l.trim())
    )
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function loadSeriesHistory(input: {
  deps: GatherDeps;
  meetingService: MeetingService | null;
  title: string;
  seriesId: string | null;
  cadence: string | null;
  pastInstances: CalendarInstance[];
  beforeMs: number;
}): Promise<SeriesHistory> {
  const { deps, meetingService, title, seriesId, cadence, beforeMs } = input;
  const pastInstances = input.pastInstances.slice(0, 3);
  const last = pastInstances[0];
  const history: SeriesHistory = {
    seriesId,
    cadence,
    pastInstances,
    lastHeld: last ? isoDate(last.start) || null : null,
    actionItems: [],
    actionItemsFrom: null,
  };

  if (last) {
    deps.connectors.mark('calendar', 'Calendar', 'checked');
    const getTool = findToolName(deps.mcp, DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID, ['get_event']);
    const body = getTool ? await safeCallTool(deps.mcp, getTool, { event_id: last.id }) : null;
    const excerpt = body ? inviteExcerpt(body) : '';
    deps.pool.add({
      source: 'calendar',
      title: `Calendar: previous "${last.title || title}", ${history.lastHeld}`,
      excerpt: excerpt || `Previous occurrence on ${history.lastHeld}`,
      url: last.htmlLink || undefined,
      when: history.lastHeld || undefined,
      tags: ['previous-instance'],
    });
    deps.connectors.hit('calendar');
  }

  if (!meetingService) {
    deps.connectors.mark('meeting', 'Meeting notes', 'skipped', 'unavailable');
    return history;
  }
  deps.connectors.mark('meeting', 'Meeting notes', 'checked');

  const lookbackMs = beforeMs - SERIES_LOOKBACK_DAYS * 864e5;
  const instanceDates = new Set(
    pastInstances.map((i) => isoDate(i.start)).filter((d): d is string => Boolean(d))
  );
  const normTitle = normalizeSeriesTitle(title);
  const listed = meetingService
    .list()
    .filter((m) => m.startedAt >= lookbackMs && m.startedAt < beforeMs)
    .filter((m) => {
      const date = isoDate(m.startedAt);
      return (
        normalizeSeriesTitle(m.title) === normTitle || (date ? instanceDates.has(date) : false)
      );
    })
    .slice(0, 12);
  const full = listed
    .map((m) => meetingService.get(m.id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  const matched = matchLocalSeriesMeetings(full, {
    seriesId,
    title,
    instanceDates,
    beforeMs,
  }).slice(0, 3);

  let actionSource: { evidenceId: string; date?: string; items: string[] } | null = null;
  for (const meeting of matched) {
    const notes = meeting.notes;
    const date = isoDate(meeting.startedAt);
    const excerpt = [
      notes?.summary,
      notes?.keyTopics?.length ? `Topics: ${notes.keyTopics.join('; ')}` : '',
      notes?.actionItems?.length ? `Action items: ${notes.actionItems.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (!excerpt) continue;
    const evidenceId = deps.pool.add({
      source: 'meeting',
      title: `Meeting notes: ${notes?.title || meeting.title}${date ? `, ${date}` : ''}`,
      excerpt,
      when: date,
      people: meeting.attendees,
      tags: ['prior-meeting'],
    });
    deps.connectors.hit('meeting');
    if (!actionSource && notes?.actionItems?.length) {
      actionSource = { evidenceId, date, items: notes.actionItems };
    }
  }

  if (actionSource) {
    history.actionItemsFrom = actionSource.date || history.lastHeld;
    history.actionItems = actionSource.items
      .filter((t) => t.trim())
      .slice(0, 8)
      .map((raw): PriorActionItem => {
        const parsed = parseActionOwner(raw);
        return {
          text: parsed.text,
          owner: parsed.owner,
          originEvidenceId: actionSource!.evidenceId,
          fromDate: actionSource!.date,
          evidenceIds: [],
        };
      });
  }
  return history;
}
