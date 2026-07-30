import { startConnectorMcpServer } from './connector-mcp-utils';

const accessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
if (!accessToken) {
  throw new Error('GOOGLE_ACCESS_TOKEN is required for Gmail connector MCP');
}

type GmailFetchOptions = {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
};

function formatGmailError(status: number, message: string, context: string): Error {
  const lower = message.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    lower.includes('insufficient') ||
    lower.includes('insufficient authentication') ||
    lower.includes('access not configured') ||
    lower.includes('request had insufficient authentication scopes')
  ) {
    return new Error(
      `${context} failed because the Google connector needs to be reconnected with Gmail compose/send access.`
    );
  }
  return new Error(`${context} failed: ${message || 'unknown_error'}`);
}

async function fetchJson(
  url: string,
  options: GmailFetchOptions = {}
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as { message?: string } | undefined;
    const message = error?.message || response.statusText || 'Gmail API request failed';
    throw formatGmailError(response.status, message, 'Gmail API request');
  }
  return payload;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function extractHeaderMap(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  const headers = Array.isArray((payload as { headers?: unknown }).headers)
    ? ((payload as { headers: Array<{ name?: string; value?: string }> }).headers ?? [])
    : [];
  const map: Record<string, string> = {};
  for (const header of headers) {
    if (!header?.name || typeof header.value !== 'string') continue;
    map[header.name.toLowerCase()] = header.value;
  }
  return map;
}

function extractHeaders(payload: unknown): { subject: string; from: string } {
  const headers = extractHeaderMap(payload);
  return { subject: headers.subject || '', from: headers.from || '' };
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

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseAddressList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .join(', ');
  }
  return optionalString(value);
}

function ensureReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return 'Re:';
  return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function buildRawMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    '',
    input.body,
  ];
  return encodeBase64Url(lines.join('\r\n'));
}

async function resolveReplyContext(replyToMessageId: string): Promise<{
  to: string;
  subject: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}> {
  const payload = await fetchJson(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(replyToMessageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`
  );
  const headers = extractHeaderMap(payload.payload);
  const messageIdHeader = headers['message-id'] || '';
  const references = [headers.references, messageIdHeader].filter(Boolean).join(' ').trim();
  const replyTo = headers['reply-to'] || headers.from || headers.to || '';
  return {
    to: replyTo,
    subject: ensureReplySubject(headers.subject || ''),
    threadId: typeof payload.threadId === 'string' ? payload.threadId : undefined,
    inReplyTo: messageIdHeader || undefined,
    references: references || undefined,
  };
}

async function buildOutboundRaw(args: Record<string, unknown>): Promise<{
  raw: string;
  threadId?: string;
  to: string;
  subject: string;
}> {
  const replyToMessageId = optionalString(args.reply_to_message_id);
  const replyContext = replyToMessageId ? await resolveReplyContext(replyToMessageId) : null;

  const to = parseAddressList(args.to) || replyContext?.to || '';
  const subject = optionalString(args.subject) || replyContext?.subject || '';
  const body = optionalString(args.body);
  const cc = parseAddressList(args.cc);
  const bcc = parseAddressList(args.bcc);

  if (!to) {
    throw new Error('Gmail "to" address is required.');
  }
  if (!subject) {
    throw new Error('Gmail subject is required.');
  }
  if (!body) {
    throw new Error('Gmail body is required.');
  }

  return {
    raw: buildRawMessage({
      to,
      subject,
      body,
      cc: cc || undefined,
      bcc: bcc || undefined,
      inReplyTo: replyContext?.inReplyTo,
      references: replyContext?.references,
    }),
    threadId: replyContext?.threadId,
    to,
    subject,
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
      {
        name: 'send_email',
        description:
          'Send a Gmail message, optionally as a reply to an existing message. Requires user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            to: {
              type: 'string',
              description: 'Recipient email(s), comma-separated. Optional when replying.',
            },
            subject: {
              type: 'string',
              description: 'Email subject. Optional when replying (defaults to Re: …).',
            },
            body: { type: 'string', description: 'Plain-text email body.' },
            cc: { type: 'string', description: 'Optional Cc recipients, comma-separated.' },
            bcc: { type: 'string', description: 'Optional Bcc recipients, comma-separated.' },
            reply_to_message_id: {
              type: 'string',
              description: 'Optional Gmail message id to reply in the same thread.',
            },
          },
          required: ['body'],
        },
      },
      {
        name: 'create_draft',
        description: 'Create a Gmail draft without sending. Requires user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            to: {
              type: 'string',
              description: 'Recipient email(s), comma-separated. Optional when replying.',
            },
            subject: {
              type: 'string',
              description: 'Email subject. Optional when replying (defaults to Re: …).',
            },
            body: { type: 'string', description: 'Plain-text email body.' },
            cc: { type: 'string', description: 'Optional Cc recipients, comma-separated.' },
            bcc: { type: 'string', description: 'Optional Bcc recipients, comma-separated.' },
            reply_to_message_id: {
              type: 'string',
              description: 'Optional Gmail message id to draft a reply in the same thread.',
            },
          },
          required: ['body'],
        },
      },
      {
        name: 'update_draft',
        description: 'Update an existing Gmail draft. Requires user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            draft_id: { type: 'string', description: 'Gmail draft id to update.' },
            to: { type: 'string', description: 'Recipient email(s), comma-separated.' },
            subject: { type: 'string', description: 'Email subject.' },
            body: { type: 'string', description: 'Plain-text email body.' },
            cc: { type: 'string', description: 'Optional Cc recipients, comma-separated.' },
            bcc: { type: 'string', description: 'Optional Bcc recipients, comma-separated.' },
          },
          required: ['draft_id', 'to', 'subject', 'body'],
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
      send_email: async (args) => {
        const outbound = await buildOutboundRaw(args);
        const payload = await fetchJson(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          {
            method: 'POST',
            body: {
              raw: outbound.raw,
              ...(outbound.threadId ? { threadId: outbound.threadId } : {}),
            },
          }
        );
        return {
          ok: true,
          message_id: typeof payload.id === 'string' ? payload.id : null,
          thread_id: typeof payload.threadId === 'string' ? payload.threadId : null,
          to: outbound.to,
          subject: outbound.subject,
        };
      },
      create_draft: async (args) => {
        const outbound = await buildOutboundRaw(args);
        const payload = await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
          method: 'POST',
          body: {
            message: {
              raw: outbound.raw,
              ...(outbound.threadId ? { threadId: outbound.threadId } : {}),
            },
          },
        });
        const message =
          payload.message && typeof payload.message === 'object'
            ? (payload.message as Record<string, unknown>)
            : {};
        return {
          ok: true,
          draft_id: typeof payload.id === 'string' ? payload.id : null,
          message_id: typeof message.id === 'string' ? message.id : null,
          thread_id: typeof message.threadId === 'string' ? message.threadId : null,
          to: outbound.to,
          subject: outbound.subject,
        };
      },
      update_draft: async (args) => {
        const draftId = optionalString(args.draft_id);
        if (!draftId) {
          throw new Error('Gmail draft_id is required.');
        }
        const outbound = await buildOutboundRaw(args);
        const payload = await fetchJson(
          `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`,
          {
            method: 'PUT',
            body: {
              id: draftId,
              message: {
                raw: outbound.raw,
              },
            },
          }
        );
        const message =
          payload.message && typeof payload.message === 'object'
            ? (payload.message as Record<string, unknown>)
            : {};
        return {
          ok: true,
          draft_id: typeof payload.id === 'string' ? payload.id : draftId,
          message_id: typeof message.id === 'string' ? message.id : null,
          thread_id: typeof message.threadId === 'string' ? message.threadId : null,
          to: outbound.to,
          subject: outbound.subject,
        };
      },
    },
  });
}

void main();
