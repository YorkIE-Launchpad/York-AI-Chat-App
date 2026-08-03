import { startConnectorMcpServer } from './connector-mcp-utils';

const accessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
if (!accessToken) {
  throw new Error('GOOGLE_ACCESS_TOKEN is required for Google Calendar connector MCP');
}

type CalendarFetchOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
};

const ALL_DAY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatCalendarError(status: number, message: string, context: string): Error {
  const lower = message.toLowerCase();
  if (
    status === 401 ||
    lower.includes('invalid credentials') ||
    lower.includes('token expired') ||
    lower.includes('token has been expired')
  ) {
    return new Error(
      `${context} failed because the Google access token expired. The app will refresh it automatically.`
    );
  }
  if (
    status === 403 ||
    lower.includes('insufficient') ||
    lower.includes('insufficient authentication') ||
    lower.includes('access not configured') ||
    lower.includes('request had insufficient authentication scopes')
  ) {
    return new Error(
      `${context} failed because the Google connector needs to be reconnected with Calendar events access.`
    );
  }
  return new Error(`${context} failed: ${message || 'unknown_error'}`);
}

async function fetchJson(
  url: string,
  options: CalendarFetchOptions = {}
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const rawText = await response.text();
  let payload: Record<string, unknown> = {};
  if (rawText.trim()) {
    try {
      payload = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      if (!response.ok) {
        throw formatCalendarError(
          response.status,
          rawText || response.statusText || 'Calendar API request failed',
          'Calendar API request'
        );
      }
      throw new Error('Calendar API returned a non-JSON response.');
    }
  }

  if (!response.ok) {
    const error = payload.error as { message?: string } | undefined;
    const message = error?.message || response.statusText || 'Calendar API request failed';
    throw formatCalendarError(response.status, message, 'Calendar API request');
  }

  return payload;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function eventStartMs(event: Record<string, unknown>): number | undefined {
  const start = event.start;
  if (!start || typeof start !== 'object') return undefined;
  const startObj = start as { dateTime?: string; date?: string };
  const raw = startObj.dateTime || startObj.date;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function summarizeEvent(event: Record<string, unknown>): string {
  const summary =
    typeof event.summary === 'string' && event.summary.trim() ? event.summary.trim() : '(no title)';
  const id = typeof event.id === 'string' ? event.id : '';
  const start = event.start as { dateTime?: string; date?: string } | undefined;
  const end = event.end as { dateTime?: string; date?: string } | undefined;
  const startLabel = start?.dateTime || start?.date || '';
  const endLabel = end?.dateTime || end?.date || '';
  const when = [startLabel, endLabel].filter(Boolean).join(' → ');
  return [id ? `${id}:` : '', summary, when ? `(${when})` : ''].filter(Boolean).join(' ');
}

function buildEnvelope(input: {
  externalId: string;
  title: string;
  summary: string;
  body: string;
  occurredAt?: number;
  keywords?: string[];
}) {
  return {
    ...input,
    ingest: true,
    memoryTitle: input.title,
    memorySummary: input.summary,
    memoryBody: input.body,
    coreKey: 'calendar_latest_read',
    coreValue: input.title,
  };
}

function parseEventBoundary(value: string): { date: string } | { dateTime: string } {
  if (ALL_DAY_DATE_RE.test(value)) {
    return { date: value };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `Invalid calendar time "${value}". Use ISO 8601 dateTime or YYYY-MM-DD for all-day.`
    );
  }
  return { dateTime: value };
}

function parseAttendees(value: unknown): Array<{ email: string }> | undefined {
  const emails: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const email = optionalString(item);
      if (email) emails.push(email);
    }
  } else {
    const raw = optionalString(value);
    if (raw) {
      for (const part of raw.split(',')) {
        const email = part.trim();
        if (email) emails.push(email);
      }
    }
  }
  if (emails.length === 0) return undefined;
  return emails.map((email) => ({ email }));
}

function buildEventBody(
  args: Record<string, unknown>,
  requireBounds: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const summary = optionalString(args.summary);
  const description = optionalString(args.description);
  const location = optionalString(args.location);
  const start = optionalString(args.start);
  const end = optionalString(args.end);
  const attendees = parseAttendees(args.attendees);

  if (summary) body.summary = summary;
  if (description) body.description = description;
  if (location) body.location = location;
  if (attendees) body.attendees = attendees;

  if (requireBounds) {
    if (!start) throw new Error('Calendar event start is required.');
    if (!end) throw new Error('Calendar event end is required.');
  }

  if (start) body.start = parseEventBoundary(start);
  if (end) body.end = parseEventBoundary(end);

  return body;
}

async function main() {
  await startConnectorMcpServer({
    serverName: 'google-calendar-connector-server',
    tools: [
      {
        name: 'list_events',
        description:
          'List Google Calendar events on the primary calendar within a time range (ISO 8601).',
        inputSchema: {
          type: 'object',
          properties: {
            time_min: {
              type: 'string',
              description: 'Inclusive start (ISO 8601). Defaults to now.',
            },
            time_max: {
              type: 'string',
              description: 'Exclusive end (ISO 8601). Defaults to 7 days after time_min.',
            },
            limit: { type: 'number' },
            query: { type: 'string', description: 'Optional free-text query (q).' },
          },
        },
      },
      {
        name: 'search_events',
        description: 'Search Google Calendar events on the primary calendar by free-text query.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            time_min: { type: 'string' },
            time_max: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_event',
        description: 'Read a Google Calendar event by event id from the primary calendar.',
        inputSchema: {
          type: 'object',
          properties: {
            event_id: { type: 'string' },
          },
          required: ['event_id'],
        },
      },
      {
        name: 'create_event',
        description:
          'Create a Google Calendar event on the primary calendar (may prompt for permission).',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Event title.' },
            start: {
              type: 'string',
              description: 'Start time (ISO 8601) or all-day date (YYYY-MM-DD).',
            },
            end: {
              type: 'string',
              description: 'End time (ISO 8601) or all-day end date (YYYY-MM-DD).',
            },
            description: { type: 'string' },
            location: { type: 'string' },
            attendees: {
              type: 'string',
              description: 'Optional attendee emails, comma-separated.',
            },
          },
          required: ['summary', 'start', 'end'],
        },
      },
      {
        name: 'update_event',
        description:
          'Update fields on an existing Google Calendar event (may prompt for permission).',
        inputSchema: {
          type: 'object',
          properties: {
            event_id: { type: 'string' },
            summary: { type: 'string' },
            start: { type: 'string' },
            end: { type: 'string' },
            description: { type: 'string' },
            location: { type: 'string' },
            attendees: {
              type: 'string',
              description: 'Optional attendee emails, comma-separated.',
            },
          },
          required: ['event_id'],
        },
      },
      {
        name: 'delete_event',
        description: 'Delete a Google Calendar event by id (may prompt for permission).',
        inputSchema: {
          type: 'object',
          properties: {
            event_id: { type: 'string' },
          },
          required: ['event_id'],
        },
      },
    ],
    handlers: {
      list_events: async (args) => {
        const now = Date.now();
        const timeMin =
          typeof args.time_min === 'string' && args.time_min.trim()
            ? args.time_min.trim()
            : new Date(now).toISOString();
        const timeMax =
          typeof args.time_max === 'string' && args.time_max.trim()
            ? args.time_max.trim()
            : new Date(Date.parse(timeMin) + 7 * 24 * 60 * 60 * 1000).toISOString();
        const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        url.searchParams.set('timeMin', timeMin);
        url.searchParams.set('timeMax', timeMax);
        url.searchParams.set('singleEvents', 'true');
        url.searchParams.set('orderBy', 'startTime');
        url.searchParams.set(
          'maxResults',
          String(typeof args.limit === 'number' ? args.limit : 20)
        );
        if (typeof args.query === 'string' && args.query.trim()) {
          url.searchParams.set('q', args.query.trim());
        }
        const payload = await fetchJson(url.toString());
        const items = Array.isArray(payload.items)
          ? (payload.items as Record<string, unknown>[])
          : [];
        const lines = items.map(summarizeEvent);
        return buildEnvelope({
          externalId: `calendar:list:${timeMin}:${timeMax}`,
          title: `Calendar events ${timeMin} → ${timeMax}`,
          summary: `Found ${items.length} calendar events`,
          body: lines.join('\n'),
          occurredAt: now,
          keywords: ['calendar', 'events', ...(typeof args.query === 'string' ? [args.query] : [])],
        });
      },
      search_events: async (args) => {
        const query = String(args.query || '').trim();
        const now = Date.now();
        const timeMin =
          typeof args.time_min === 'string' && args.time_min.trim()
            ? args.time_min.trim()
            : new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
        const timeMax =
          typeof args.time_max === 'string' && args.time_max.trim()
            ? args.time_max.trim()
            : new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();
        const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        url.searchParams.set('q', query);
        url.searchParams.set('timeMin', timeMin);
        url.searchParams.set('timeMax', timeMax);
        url.searchParams.set('singleEvents', 'true');
        url.searchParams.set('orderBy', 'startTime');
        url.searchParams.set(
          'maxResults',
          String(typeof args.limit === 'number' ? args.limit : 20)
        );
        const payload = await fetchJson(url.toString());
        const items = Array.isArray(payload.items)
          ? (payload.items as Record<string, unknown>[])
          : [];
        const lines = items.map(summarizeEvent);
        return buildEnvelope({
          externalId: `calendar:search:${query}`,
          title: `Calendar search: ${query}`,
          summary: `Found ${items.length} calendar events`,
          body: lines.join('\n'),
          occurredAt: now,
          keywords: ['calendar', 'search', ...query.split(/\s+/).filter(Boolean)],
        });
      },
      get_event: async (args) => {
        const eventId = String(args.event_id || '').trim();
        const payload = await fetchJson(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`
        );
        const title =
          typeof payload.summary === 'string' && payload.summary.trim()
            ? payload.summary.trim()
            : `Event ${eventId}`;
        const description =
          typeof payload.description === 'string' ? payload.description : summarizeEvent(payload);
        const location = typeof payload.location === 'string' ? payload.location : '';
        const htmlLink = typeof payload.htmlLink === 'string' ? payload.htmlLink : '';

        // Resolve RRULE for series instances (instances only expose recurringEventId).
        let recurrenceLines: string[] = Array.isArray(payload.recurrence)
          ? (payload.recurrence as unknown[]).filter((r): r is string => typeof r === 'string')
          : [];
        const recurringEventId =
          typeof payload.recurringEventId === 'string' ? payload.recurringEventId.trim() : '';
        if (!recurrenceLines.length && recurringEventId) {
          try {
            const master = await fetchJson(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(recurringEventId)}`
            );
            if (Array.isArray(master.recurrence)) {
              recurrenceLines = (master.recurrence as unknown[]).filter(
                (r): r is string => typeof r === 'string'
              );
            }
          } catch {
            // Master may be inaccessible; still mark as recurring below.
          }
        }

        const body = [
          summarizeEvent(payload),
          location ? `Location: ${location}` : '',
          htmlLink ? `Link: ${htmlLink}` : '',
          description && description !== title ? description : '',
          recurringEventId ? `RecurringEventId: ${recurringEventId}` : '',
          recurrenceLines.length ? `Recurrence:\n${recurrenceLines.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        return buildEnvelope({
          externalId: eventId,
          title,
          summary: summarizeEvent(payload),
          body,
          occurredAt: eventStartMs(payload) ?? Date.now(),
          keywords: [
            'calendar',
            'event',
            title,
            ...(recurringEventId || recurrenceLines.length ? ['recurring'] : []),
            ...(recurrenceLines.some((r) => /FREQ=DAILY/i.test(r)) ? ['daily'] : []),
          ],
        });
      },
      create_event: async (args) => {
        const summary = optionalString(args.summary);
        if (!summary) {
          throw new Error('Calendar event summary is required.');
        }
        const eventBody = buildEventBody({ ...args, summary }, true);
        const payload = await fetchJson(
          'https://www.googleapis.com/calendar/v3/calendars/primary/events',
          { method: 'POST', body: eventBody }
        );
        return {
          ok: true,
          event_id: typeof payload.id === 'string' ? payload.id : null,
          html_link: typeof payload.htmlLink === 'string' ? payload.htmlLink : null,
          summary: typeof payload.summary === 'string' ? payload.summary : summary,
        };
      },
      update_event: async (args) => {
        const eventId = optionalString(args.event_id);
        if (!eventId) {
          throw new Error('Calendar event_id is required.');
        }
        const eventBody = buildEventBody(args, false);
        if (Object.keys(eventBody).length === 0) {
          throw new Error('Provide at least one field to update on the calendar event.');
        }
        const payload = await fetchJson(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
          { method: 'PATCH', body: eventBody }
        );
        return {
          ok: true,
          event_id: typeof payload.id === 'string' ? payload.id : eventId,
          html_link: typeof payload.htmlLink === 'string' ? payload.htmlLink : null,
          summary: typeof payload.summary === 'string' ? payload.summary : null,
        };
      },
      delete_event: async (args) => {
        const eventId = optionalString(args.event_id);
        if (!eventId) {
          throw new Error('Calendar event_id is required.');
        }
        await fetchJson(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
          { method: 'DELETE' }
        );
        return {
          ok: true,
          event_id: eventId,
          deleted: true,
        };
      },
    },
  });
}

void main();
