import { connectorManager } from '../connectors/connector-manager';
import { logWarn } from '../utils/logger';

export interface CalendarMeetingMatch {
  title: string;
  attendees: string[];
  eventId: string;
  htmlLink?: string;
  hangoutLink?: string;
}

function looksLikeZoomEvent(event: Record<string, unknown>): boolean {
  const haystacks: string[] = [];
  for (const key of ['summary', 'description', 'location', 'hangoutLink'] as const) {
    const value = event[key];
    if (typeof value === 'string' && value.trim()) {
      haystacks.push(value.toLowerCase());
    }
  }
  const conf =
    event.conferenceData && typeof event.conferenceData === 'object'
      ? (event.conferenceData as { entryPoints?: Array<{ uri?: string }> })
      : null;
  for (const entry of conf?.entryPoints || []) {
    if (typeof entry.uri === 'string') {
      haystacks.push(entry.uri.toLowerCase());
    }
  }
  return haystacks.some(
    (text) =>
      text.includes('zoom.us') ||
      text.includes('zoom.com') ||
      text.includes('zoom meeting') ||
      /\bzoom\b/.test(text)
  );
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
 * Uses Gmail or Google Drive connector token (both request calendar.readonly).
 */
export async function findCurrentCalendarMeeting(
  now = Date.now()
): Promise<CalendarMeetingMatch | null> {
  const connectorId = connectorManager.isConnected('gmail')
    ? 'gmail'
    : connectorManager.isConnected('google-drive')
      ? 'google-drive'
      : null;
  if (!connectorId) {
    return null;
  }

  try {
    const record = await connectorManager.ensureFreshAccessToken(connectorId);
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
    };
  } catch (error) {
    logWarn('[Calendar] findCurrentCalendarMeeting error', error);
    return null;
  }
}
