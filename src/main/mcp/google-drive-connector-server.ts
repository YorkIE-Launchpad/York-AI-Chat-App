import { startConnectorMcpServer } from './connector-mcp-utils';

const accessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
if (!accessToken) {
  throw new Error('GOOGLE_ACCESS_TOKEN is required for Google Drive connector MCP');
}

const DOCS_MIME = 'application/vnd.google-apps.document';
const SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

type DriveFetchOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
};

function formatDriveError(status: number, message: string, context: string): Error {
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
      `${context} failed because the Google connector needs to be reconnected with Drive/Docs/Sheets write access.`
    );
  }
  return new Error(`${context} failed: ${message || 'unknown_error'}`);
}

async function fetchJson(
  url: string,
  options: DriveFetchOptions = {}
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
        throw formatDriveError(
          response.status,
          rawText || response.statusText || 'Drive API request failed',
          'Drive API request'
        );
      }
      throw new Error('Drive API returned a non-JSON response.');
    }
  }

  if (!response.ok) {
    const error = payload.error as { message?: string } | undefined;
    const message = error?.message || response.statusText || 'Drive API request failed';
    throw formatDriveError(response.status, message, 'Drive API request');
  }

  return payload;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw formatDriveError(
      response.status,
      text || response.statusText || 'Drive export request failed',
      'Drive API request'
    );
  }
  return text;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function endIndexOfDocument(doc: Record<string, unknown>): number {
  const body = doc.body;
  if (!body || typeof body !== 'object') return 1;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return 1;
  let maxEnd = 1;
  for (const element of content) {
    if (!element || typeof element !== 'object') continue;
    const endIndex = (element as { endIndex?: unknown }).endIndex;
    if (typeof endIndex === 'number' && Number.isFinite(endIndex)) {
      maxEnd = Math.max(maxEnd, endIndex);
    }
  }
  return maxEnd;
}

async function insertDocumentText(documentId: string, text: string): Promise<void> {
  await fetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      body: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text,
            },
          },
        ],
      },
    }
  );
}

async function replaceDocumentText(documentId: string, text: string): Promise<void> {
  const doc = await fetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`
  );
  const endIndex = endIndexOfDocument(doc);
  const requests: Record<string, unknown>[] = [];

  // Docs require leaving the final newline; delete up to endIndex - 1 when content exists.
  if (endIndex > 2) {
    requests.push({
      deleteContentRange: {
        range: {
          startIndex: 1,
          endIndex: endIndex - 1,
        },
      },
    });
  }

  if (text) {
    requests.push({
      insertText: {
        location: { index: 1 },
        text,
      },
    });
  }

  if (requests.length === 0) {
    return;
  }

  await fetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      body: { requests },
    }
  );
}

/** Parse a 2D array of cell values from tool args (numbers/booleans accepted as strings). */
function parseSheetValues(value: unknown): string[][] {
  if (!Array.isArray(value)) {
    throw new Error('values must be a 2D array of cell values (rows of columns).');
  }
  return value.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Error(`values[${rowIndex}] must be an array of cell values.`);
    }
    return row.map((cell) => {
      if (cell === null || cell === undefined) return '';
      if (typeof cell === 'string') return cell;
      if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
      throw new Error(`values[${rowIndex}] contains a non-scalar cell value.`);
    });
  });
}

async function updateSpreadsheetValues(
  spreadsheetId: string,
  range: string,
  values: string[][],
  valueInputOption: string
): Promise<Record<string, unknown>> {
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );
  url.searchParams.set('valueInputOption', valueInputOption);
  return fetchJson(url.toString(), {
    method: 'PUT',
    body: {
      range,
      majorDimension: 'ROWS',
      values,
    },
  });
}

async function getSpreadsheetValues(
  spreadsheetId: string,
  range: string
): Promise<Record<string, unknown>> {
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );
  return fetchJson(url.toString());
}

async function firstSheetTitle(spreadsheetId: string): Promise<string> {
  const payload = await fetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`
  );
  const sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
  for (const sheet of sheets) {
    if (!sheet || typeof sheet !== 'object') continue;
    const properties = (sheet as { properties?: unknown }).properties;
    if (!properties || typeof properties !== 'object') continue;
    const title = (properties as { title?: unknown }).title;
    if (typeof title === 'string' && title.trim()) {
      return title.trim();
    }
  }
  return 'Sheet1';
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
        description:
          'Fetch textual content for a Google Doc (plain text), Google Sheet (CSV), or other Drive file.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string' },
          },
          required: ['file_id'],
        },
      },
      {
        name: 'create_document',
        description:
          'Create a Google Doc. Optional initial plain-text body. Requires user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Document title.' },
            body: { type: 'string', description: 'Optional initial plain-text content.' },
            parent_folder_id: {
              type: 'string',
              description: 'Optional parent folder id.',
            },
          },
          required: ['title'],
        },
      },
      {
        name: 'update_document_content',
        description: 'Replace the plain-text body of a Google Doc. Requires user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'Google Doc file id.' },
            body: { type: 'string', description: 'New plain-text document body.' },
          },
          required: ['file_id', 'body'],
        },
      },
      {
        name: 'create_spreadsheet',
        description:
          'Create a Google Sheet. Optional initial 2D values written to the first sheet. Requires user approval. Prefer this over local xlsx when the user wants a Google Sheet.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Spreadsheet title.' },
            values: {
              type: 'array',
              description:
                'Optional initial rows of cell values (2D array). Written starting at A1 on the first sheet.',
              items: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            parent_folder_id: {
              type: 'string',
              description: 'Optional parent folder id.',
            },
          },
          required: ['title'],
        },
      },
      {
        name: 'get_spreadsheet_values',
        description: 'Read cell values from a Google Sheet by file id and A1 range.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'Google Sheet file id.' },
            range: {
              type: 'string',
              description:
                'A1 notation range (e.g. "Sheet1!A1:D10" or "A1:D10"). Defaults to the first sheet.',
            },
          },
          required: ['file_id'],
        },
      },
      {
        name: 'update_spreadsheet_values',
        description:
          'Write cell values to a Google Sheet range (overwrites). Requires user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'Google Sheet file id.' },
            range: {
              type: 'string',
              description: 'A1 notation range to write (e.g. "Sheet1!A1" or "A1").',
            },
            values: {
              type: 'array',
              description: 'Rows of cell values (2D array).',
              items: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            value_input_option: {
              type: 'string',
              description: 'USER_ENTERED (default) or RAW.',
            },
          },
          required: ['file_id', 'range', 'values'],
        },
      },
      {
        name: 'create_folder',
        description: 'Create a Google Drive folder. Requires user approval.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Folder name.' },
            parent_folder_id: {
              type: 'string',
              description: 'Optional parent folder id.',
            },
          },
          required: ['name'],
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
        if (mimeType === DOCS_MIME) {
          body = await fetchText(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`
          );
        } else if (mimeType === SHEETS_MIME) {
          body = await fetchText(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/csv`
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
      create_document: async (args) => {
        const title = optionalString(args.title);
        if (!title) {
          throw new Error('Document title is required.');
        }
        const body = optionalString(args.body);
        const parentFolderId = optionalString(args.parent_folder_id);
        const createBody: Record<string, unknown> = {
          name: title,
          mimeType: DOCS_MIME,
        };
        if (parentFolderId) {
          createBody.parents = [parentFolderId];
        }
        const created = await fetchJson(
          'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,mimeType',
          {
            method: 'POST',
            body: createBody,
          }
        );
        const fileId = typeof created.id === 'string' ? created.id : '';
        if (!fileId) {
          throw new Error('Drive API did not return a file id for the new document.');
        }
        if (body) {
          await insertDocumentText(fileId, body);
        }
        return {
          ok: true,
          file_id: fileId,
          name: typeof created.name === 'string' ? created.name : title,
          web_view_link: typeof created.webViewLink === 'string' ? created.webViewLink : null,
        };
      },
      update_document_content: async (args) => {
        const fileId = optionalString(args.file_id);
        if (!fileId) {
          throw new Error('file_id is required.');
        }
        if (typeof args.body !== 'string') {
          throw new Error('Document body is required.');
        }
        const metadata = await fetchJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink`
        );
        if (String(metadata.mimeType || '') !== DOCS_MIME) {
          throw new Error('update_document_content only supports Google Docs files.');
        }
        await replaceDocumentText(fileId, args.body);
        return {
          ok: true,
          file_id: fileId,
          name: typeof metadata.name === 'string' ? metadata.name : null,
          web_view_link: typeof metadata.webViewLink === 'string' ? metadata.webViewLink : null,
        };
      },
      create_spreadsheet: async (args) => {
        const title = optionalString(args.title);
        if (!title) {
          throw new Error('Spreadsheet title is required.');
        }
        const parentFolderId = optionalString(args.parent_folder_id);
        const createBody: Record<string, unknown> = {
          name: title,
          mimeType: SHEETS_MIME,
        };
        if (parentFolderId) {
          createBody.parents = [parentFolderId];
        }
        const created = await fetchJson(
          'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,mimeType',
          {
            method: 'POST',
            body: createBody,
          }
        );
        const fileId = typeof created.id === 'string' ? created.id : '';
        if (!fileId) {
          throw new Error('Drive API did not return a file id for the new spreadsheet.');
        }
        let updatedRange: string | null = null;
        if (args.values !== undefined && args.values !== null) {
          const values = parseSheetValues(args.values);
          if (values.length > 0) {
            const result = await updateSpreadsheetValues(fileId, 'A1', values, 'USER_ENTERED');
            updatedRange = typeof result.updatedRange === 'string' ? result.updatedRange : 'A1';
          }
        }
        return {
          ok: true,
          file_id: fileId,
          name: typeof created.name === 'string' ? created.name : title,
          web_view_link: typeof created.webViewLink === 'string' ? created.webViewLink : null,
          updated_range: updatedRange,
        };
      },
      get_spreadsheet_values: async (args) => {
        const fileId = optionalString(args.file_id);
        if (!fileId) {
          throw new Error('file_id is required.');
        }
        const metadata = await fetchJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink`
        );
        if (String(metadata.mimeType || '') !== SHEETS_MIME) {
          throw new Error('get_spreadsheet_values only supports Google Sheets files.');
        }
        const range = optionalString(args.range) || (await firstSheetTitle(fileId));
        const payload = await getSpreadsheetValues(fileId, range);
        const values = Array.isArray(payload.values) ? payload.values : [];
        return buildEnvelope({
          externalId: `drive:sheet:${fileId}:${range}`,
          title: String(metadata.name || fileId),
          summary: `Fetched spreadsheet values for ${String(metadata.name || fileId)} (${range})`,
          body: JSON.stringify(
            {
              range: typeof payload.range === 'string' ? payload.range : range,
              values,
              web_view_link: typeof metadata.webViewLink === 'string' ? metadata.webViewLink : null,
            },
            null,
            2
          ),
          occurredAt: Date.now(),
          keywords: ['drive', 'spreadsheet', String(metadata.name || fileId)],
        });
      },
      update_spreadsheet_values: async (args) => {
        const fileId = optionalString(args.file_id);
        if (!fileId) {
          throw new Error('file_id is required.');
        }
        const range = optionalString(args.range);
        if (!range) {
          throw new Error('range is required.');
        }
        const values = parseSheetValues(args.values);
        const valueInputOption =
          optionalString(args.value_input_option).toUpperCase() || 'USER_ENTERED';
        if (valueInputOption !== 'USER_ENTERED' && valueInputOption !== 'RAW') {
          throw new Error('value_input_option must be USER_ENTERED or RAW.');
        }
        const metadata = await fetchJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink`
        );
        if (String(metadata.mimeType || '') !== SHEETS_MIME) {
          throw new Error('update_spreadsheet_values only supports Google Sheets files.');
        }
        const result = await updateSpreadsheetValues(fileId, range, values, valueInputOption);
        return {
          ok: true,
          file_id: fileId,
          name: typeof metadata.name === 'string' ? metadata.name : null,
          web_view_link: typeof metadata.webViewLink === 'string' ? metadata.webViewLink : null,
          updated_range: typeof result.updatedRange === 'string' ? result.updatedRange : range,
          updated_rows: typeof result.updatedRows === 'number' ? result.updatedRows : values.length,
          updated_columns: typeof result.updatedColumns === 'number' ? result.updatedColumns : null,
          updated_cells: typeof result.updatedCells === 'number' ? result.updatedCells : null,
        };
      },
      create_folder: async (args) => {
        const name = optionalString(args.name);
        if (!name) {
          throw new Error('Folder name is required.');
        }
        const parentFolderId = optionalString(args.parent_folder_id);
        const createBody: Record<string, unknown> = {
          name,
          mimeType: FOLDER_MIME,
        };
        if (parentFolderId) {
          createBody.parents = [parentFolderId];
        }
        const created = await fetchJson(
          'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,mimeType',
          {
            method: 'POST',
            body: createBody,
          }
        );
        return {
          ok: true,
          file_id: typeof created.id === 'string' ? created.id : null,
          name: typeof created.name === 'string' ? created.name : name,
          web_view_link: typeof created.webViewLink === 'string' ? created.webViewLink : null,
        };
      },
    },
  });
}

void main();
