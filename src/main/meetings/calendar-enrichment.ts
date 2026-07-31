import { connectorManager } from '../connectors/connector-manager';
import { logWarn } from '../utils/logger';

export interface CalendarMeetingMatch {
  title: string;
  attendees: string[];
  eventId: string;
  htmlLink?: string;
  hangoutLink?: string;
  /** Numeric Zoom meeting ID parsed from event links when available. */
  zoomMeetingId?: string | null;
}

/** Extract a Zoom meeting numeric ID from free-text / URLs. */
export function extractZoomMeetingIdFromText(text: string): string | null {
  if (!text?.trim()) return null;
  const patterns = [
    /zoom\.us\/j\/(\d{9,13})/i,
    /zoom\.us\/s\/(\d{9,13})/i,
    /zoom\.us\/wc\/join\/(\d{9,13})/i,
    /zoom\.us\/meeting\/(\d{9,13})/i,
    /zoom\.us\/w\/(\d{9,13})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function collectEventHaystacks(event: Record<string, unknown>): string[] {
  const haystacks: string[] = [];
  for (const key of ['summary', 'description', 'location', 'hangoutLink', 'htmlLink'] as const) {
    const value = event[key];
    if (typeof value === 'string' && value.trim()) {
      haystacks.push(value);
    }
  }
  const conf =
    event.conferenceData && typeof event.conferenceData === 'object'
      ? (event.conferenceData as { entryPoints?: Array<{ uri?: string }> })
      : null;
  for (const entry of conf?.entryPoints || []) {
    if (typeof entry.uri === 'string') {
      haystacks.push(entry.uri);
    }
  }
  return haystacks;
}

function looksLikeZoomEvent(event: Record<string, unknown>): boolean {
  return collectEventHaystacks(event).some((text) => {
    const lower = text.toLowerCase();
    return (
      lower.includes('zoom.us') ||
      lower.includes('zoom.com') ||
      lower.includes('zoom meeting') ||
      /\bzoom\b/.test(lower)
    );
  });
}

function extractZoomMeetingIdFromEvent(event: Record<string, unknown>): string | null {
  for (const text of collectEventHaystacks(event)) {
    const id = extractZoomMeetingIdFromText(text);
    if (id) return id;
  }
  return null;
}

function extractAttendees(event: Record<string, unknown>): string[] {
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  const names: string[] = [];
  for (const raw of attendees) {
    if (!raw || typeof raw !== 'object') continue;
    const attendee = raw as { displayName?: string; email?: string };
    const label =
      (typeof attendee.displayName === 'string' && attendee.displayName.trim()) ||
      (typeof attendee.email === 'string' && attendee.email.trim()) ||
      '';
    if (label) names.push(label);
  }
  return names;
}

/**
 * Match the current time to a Google Calendar event (prefer Zoom-linked events).
 * Uses the unified Google connector token (includes calendar.readonly).
 */
export async function findCurrentCalendarMeeting(
  now = Date.now()
): Promise<CalendarMeetingMatch | null> {
  if (!connectorManager.isConnected('google')) {
    return null;
  }

  try {
    const record = await connectorManager.ensureFreshAccessToken('google');
    const timeMin = new Date(now - 15 * 60_000).toISOString();
    const timeMax = new Date(now + 15 * 60_000).toISOString();
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '10');
    url.searchParams.set(
      'fields',
      'items(id,summary,description,location,htmlLink,hangoutLink,conferenceData,attendees,start,end)'
    );

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${record.accessToken}` },
    });
    const payload = (await response.json()) as {
      items?: Record<string, unknown>[];
      error?: unknown;
    };
    if (!response.ok) {
      logWarn('[Calendar] events.list failed', payload.error || response.statusText);
      return null;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) return null;

    const zoomFirst = [...items].sort((a, b) => {
      const az = looksLikeZoomEvent(a) ? 0 : 1;
      const bz = looksLikeZoomEvent(b) ? 0 : 1;
      return az - bz;
    });

    const chosen = zoomFirst[0];
    const title =
      typeof chosen.summary === 'string' && chosen.summary.trim()
        ? chosen.summary.trim()
        : 'Calendar meeting';
    return {
      title,
      attendees: extractAttendees(chosen),
      eventId: typeof chosen.id === 'string' ? chosen.id : '',
      htmlLink: typeof chosen.htmlLink === 'string' ? chosen.htmlLink : undefined,
      hangoutLink: typeof chosen.hangoutLink === 'string' ? chosen.hangoutLink : undefined,
      zoomMeetingId: extractZoomMeetingIdFromEvent(chosen),
    };
  } catch (error) {
    logWarn('[Calendar] findCurrentCalendarMeeting error', error);
    return null;
  }
}
