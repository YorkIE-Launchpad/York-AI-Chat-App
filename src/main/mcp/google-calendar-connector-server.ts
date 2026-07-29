import { startConnectorMcpServer } from './connector-mcp-utils';

const accessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
if (!accessToken) {
  throw new Error('GOOGLE_ACCESS_TOKEN is required for Google Calendar connector MCP');
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as { message?: string } | undefined;
    throw new Error(error?.message || response.statusText || 'Calendar API request failed');
  }
  return payload;
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
        const body = [
          summarizeEvent(payload),
          location ? `Location: ${location}` : '',
          htmlLink ? `Link: ${htmlLink}` : '',
          description && description !== title ? description : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        return buildEnvelope({
          externalId: eventId,
          title,
          summary: summarizeEvent(payload),
          body,
          occurredAt: eventStartMs(payload) ?? Date.now(),
          keywords: ['calendar', 'event', title],
        });
      },
    },
  });
}

void main();
