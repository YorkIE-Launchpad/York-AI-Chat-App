import { startConnectorMcpServer } from './connector-mcp-utils';

const accessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
if (!accessToken) {
  throw new Error('GOOGLE_ACCESS_TOKEN is required for Gmail connector MCP');
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as { message?: string } | undefined;
    throw new Error(error?.message || response.statusText || 'Gmail API request failed');
  }
  return payload;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractHeaders(payload: unknown): { subject: string; from: string } {
  if (!payload || typeof payload !== 'object') {
    return { subject: '', from: '' };
  }
  const headers = Array.isArray((payload as { headers?: unknown }).headers)
    ? ((payload as { headers: Array<{ name?: string; value?: string }> }).headers ?? [])
    : [];
  let subject = '';
  let from = '';
  for (const header of headers) {
    const name = header?.name?.toLowerCase();
    if (name === 'subject' && header.value) subject = header.value;
    if (name === 'from' && header.value) from = header.value;
  }
  return { subject, from };
}

function extractBody(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const bodyData = (payload as { body?: { data?: string } }).body?.data;
  if (typeof bodyData === 'string' && bodyData.trim()) {
    return decodeBase64Url(bodyData);
  }
  const parts = Array.isArray((payload as { parts?: unknown }).parts)
    ? ((payload as { parts: unknown[] }).parts ?? [])
    : [];
  return parts
    .map((part) => extractBody(part))
    .filter(Boolean)
    .join('\n')
    .trim();
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
    coreKey: 'gmail_latest_read',
    coreValue: input.title,
  };
}

async function main() {
  await startConnectorMcpServer({
    serverName: 'gmail-connector-server',
    tools: [
      {
        name: 'search_emails',
        description: 'Search Gmail using the Gmail query syntax.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_email',
        description: 'Read a Gmail message by message id.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: { type: 'string' },
          },
          required: ['message_id'],
        },
      },
      {
        name: 'list_labels',
        description: 'List Gmail labels.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
    handlers: {
      search_emails: async (args) => {
        const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
        url.searchParams.set('q', String(args.query || ''));
        url.searchParams.set(
          'maxResults',
          String(typeof args.limit === 'number' ? args.limit : 20)
        );
        const payload = await fetchJson(url.toString());
        const messages = Array.isArray(payload.messages)
          ? payload.messages
              .map((item) =>
                item &&
                typeof item === 'object' &&
                typeof (item as { id?: unknown }).id === 'string'
                  ? String((item as { id: string }).id)
                  : ''
              )
              .filter(Boolean)
          : [];
        return buildEnvelope({
          externalId: `gmail:search:${String(args.query || '')}`,
          title: `Gmail search: ${String(args.query || '')}`,
          summary: `Found ${messages.length} Gmail messages`,
          body: messages.join('\n'),
          occurredAt: Date.now(),
          keywords: [
            'gmail',
            'search',
            ...String(args.query || '')
              .split(/\s+/)
              .filter(Boolean),
          ],
        });
      },
      get_email: async (args) => {
        const messageId = String(args.message_id || '');
        const payload = await fetchJson(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`
        );
        const { subject, from } = extractHeaders(payload.payload);
        const snippet = typeof payload.snippet === 'string' ? payload.snippet : '';
        const body = extractBody(payload.payload) || snippet || subject;
        const internalDate = Number(payload.internalDate || Date.now());
        return buildEnvelope({
          externalId: messageId,
          title: subject || `Email ${messageId}`,
          summary: [subject, from ? `From: ${from}` : '', snippet].filter(Boolean).join(' | '),
          body,
          occurredAt: Number.isFinite(internalDate) ? internalDate : Date.now(),
          keywords: ['gmail', 'email', subject, from].filter(Boolean),
        });
      },
      list_labels: async () => {
        const payload = await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/labels');
        const labels = Array.isArray(payload.labels)
          ? payload.labels
              .map((item) =>
                item &&
                typeof item === 'object' &&
                typeof (item as { name?: unknown }).name === 'string'
                  ? String((item as { name: string }).name)
                  : ''
              )
              .filter(Boolean)
          : [];
        return buildEnvelope({
          externalId: `gmail:labels:${Date.now()}`,
          title: 'Gmail labels',
          summary: `Fetched ${labels.length} Gmail labels`,
          body: labels.join('\n'),
          occurredAt: Date.now(),
          keywords: ['gmail', 'labels'],
        });
      },
    },
  });
}

void main();
