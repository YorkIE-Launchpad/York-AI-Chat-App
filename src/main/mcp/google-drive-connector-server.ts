import { startConnectorMcpServer } from './connector-mcp-utils';

const accessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
if (!accessToken) {
  throw new Error('GOOGLE_ACCESS_TOKEN is required for Google Drive connector MCP');
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as { message?: string } | undefined;
    throw new Error(error?.message || response.statusText || 'Drive API request failed');
  }
  return payload;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || response.statusText || 'Drive export request failed');
  }
  return text;
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
    coreKey: 'drive_latest_read',
    coreValue: input.title,
  };
}

async function main() {
  await startConnectorMcpServer({
    serverName: 'google-drive-connector-server',
    tools: [
      {
        name: 'search_files',
        description: 'Search Google Drive files using Drive query syntax.',
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
        name: 'list_files',
        description: 'List recent Google Drive files.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
          },
        },
      },
      {
        name: 'get_file_metadata',
        description: 'Read Google Drive file metadata by file id.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string' },
          },
          required: ['file_id'],
        },
      },
      {
        name: 'get_document_content',
        description: 'Fetch a Google Doc or Drive file textual content.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string' },
          },
          required: ['file_id'],
        },
      },
    ],
    handlers: {
      search_files: async (args) => {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('q', String(args.query || ''));
        url.searchParams.set('pageSize', String(typeof args.limit === 'number' ? args.limit : 20));
        url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink)');
        const payload = await fetchJson(url.toString());
        const files = Array.isArray(payload.files)
          ? payload.files
              .map((item) =>
                item && typeof item === 'object'
                  ? {
                      id:
                        typeof (item as { id?: unknown }).id === 'string'
                          ? (item as { id: string }).id
                          : '',
                      name:
                        typeof (item as { name?: unknown }).name === 'string'
                          ? (item as { name: string }).name
                          : '',
                      mimeType:
                        typeof (item as { mimeType?: unknown }).mimeType === 'string'
                          ? (item as { mimeType: string }).mimeType
                          : '',
                    }
                  : null
              )
              .filter(Boolean)
          : [];
        return buildEnvelope({
          externalId: `drive:search:${String(args.query || '')}`,
          title: `Google Drive search: ${String(args.query || '')}`,
          summary: `Found ${files.length} Google Drive files`,
          body: files.map((file) => `${file!.name} (${file!.mimeType}) - ${file!.id}`).join('\n'),
          occurredAt: Date.now(),
          keywords: [
            'drive',
            'search',
            ...String(args.query || '')
              .split(/\s+/)
              .filter(Boolean),
          ],
        });
      },
      list_files: async (args) => {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('pageSize', String(typeof args.limit === 'number' ? args.limit : 20));
        url.searchParams.set('orderBy', 'modifiedTime desc');
        url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime)');
        const payload = await fetchJson(url.toString());
        const files = Array.isArray(payload.files)
          ? payload.files
              .map((item) =>
                item && typeof item === 'object'
                  ? `${String((item as { name?: unknown }).name || '')} (${String((item as { mimeType?: unknown }).mimeType || '')})`
                  : ''
              )
              .filter(Boolean)
          : [];
        return buildEnvelope({
          externalId: `drive:list:${Date.now()}`,
          title: 'Google Drive recent files',
          summary: `Fetched ${files.length} Google Drive files`,
          body: files.join('\n'),
          occurredAt: Date.now(),
          keywords: ['drive', 'files'],
        });
      },
      get_file_metadata: async (args) => {
        const fileId = String(args.file_id || '');
        const payload = await fetchJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,owners(displayName,emailAddress),webViewLink`
        );
        return buildEnvelope({
          externalId: `drive:meta:${fileId}`,
          title: String(payload.name || fileId),
          summary: `Fetched metadata for Google Drive file ${String(payload.name || fileId)}`,
          body: JSON.stringify(payload, null, 2),
          occurredAt: Date.now(),
          keywords: ['drive', 'metadata', String(payload.name || fileId)],
        });
      },
      get_document_content: async (args) => {
        const fileId = String(args.file_id || '');
        const metadata = await fetchJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime`
        );
        const mimeType = String(metadata.mimeType || '');
        let body = '';
        if (mimeType === 'application/vnd.google-apps.document') {
          body = await fetchText(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`
          );
        } else {
          body = await fetchText(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
          );
        }
        return buildEnvelope({
          externalId: fileId,
          title: String(metadata.name || fileId),
          summary: `Fetched content for Google Drive document ${String(metadata.name || fileId)}`,
          body,
          occurredAt: Date.now(),
          keywords: ['drive', 'document', String(metadata.name || fileId)],
        });
      },
    },
  });
}

void main();
