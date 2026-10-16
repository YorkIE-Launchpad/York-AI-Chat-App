import { describe, expect, it, vi } from 'vitest';

vi.mock('../../main/utils/logger', () => ({ logWarn: vi.fn() }));

import type { MCPManager } from '../../main/mcp/mcp-manager';
import {
  lookupExternalReferenceFromUrl,
  resolveExternalReference,
} from '../../main/references/reference-service';
import { DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID } from '../../shared/mcp-defaults';
import { DRIVE_FOLDER_MIME, parseExternalReferenceUrl } from '../../shared/external-reference-urls';

const FOLDER = DRIVE_FOLDER_MIME;
const DOC = 'application/vnd.google-apps.document';

type Node = { name: string; mimeType: string; children?: string[]; content?: string };

function fakeDrive(nodes: Record<string, Node>) {
  const envelope = (title: string, body: string) => ({
    content: [{ type: 'text', text: JSON.stringify({ title, body }) }],
  });
  const callTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === 'search_files') {
      const parent = String(args.query).match(/^'([^']+)' in parents/)?.[1] ?? '';
      const body = (nodes[parent]?.children ?? [])
        .map((id) => `${nodes[id].name} (${nodes[id].mimeType}) - ${id}`)
        .join('\n');
      return envelope('search', body);
    }
    const node = nodes[String(args.file_id)];
    if (tool === 'get_file_metadata') return envelope(node.name, '{}');
    if (tool === 'get_document_content') {
      if (node.content === undefined) throw new Error('read failed');
      return envelope(node.name, node.content);
    }
    throw new Error(`unexpected tool ${tool}`);
  });
  const mcpManager = {
    getServerStatus: () => [{ id: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, connected: true }],
    getTools: () =>
      ['search_files', 'get_file_metadata', 'get_document_content'].map((name) => ({
        name,
        originalName: name,
        serverId: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
      })),
    callTool,
  } as unknown as MCPManager;
  return { mcpManager, callTool };
}

describe('Drive folder references', () => {
  it('parses folder links, including multi-account /u/N/ links', () => {
    expect(
      parseExternalReferenceUrl(
        'https://drive.google.com/drive/u/1/folders/abc_DEF-123?usp=sharing'
      )
    ).toMatchObject({
      source: 'drive',
      externalId: 'abc_DEF-123',
      meta: { fileId: 'abc_DEF-123', mimeType: FOLDER },
    });
  });

  it('reads readable files recursively and reports skipped ones', async () => {
    const { mcpManager } = fakeDrive({
      root: { name: 'Proposal', mimeType: FOLDER, children: ['a', 'img', 'sub', 'bad'] },
      a: { name: 'Brief', mimeType: DOC, content: 'brief text' },
      img: { name: 'logo.png', mimeType: 'image/png' },
      bad: { name: 'notes.txt', mimeType: 'text/plain' },
      sub: { name: 'Research', mimeType: FOLDER, children: ['b'] },
      b: { name: 'data.csv', mimeType: 'text/csv', content: 'x,y' },
    });

    const result = await resolveExternalReference(mcpManager, {
      source: 'drive',
      externalId: 'root',
      title: 'root',
      meta: { fileId: 'root', mimeType: FOLDER },
    });

    expect(result.error).toBeUndefined();
    expect(result.title).toBe('Proposal');
    expect(result.url).toBe('https://drive.google.com/drive/folders/root');
    expect(result.text).toContain('--- Brief ---\nbrief text');
    expect(result.text).toContain('--- Research/data.csv ---\nx,y');
    expect(result.text).toContain('logo.png (unsupported type)');
    expect(result.text).toContain('notes.txt (could not be read)');
    expect(result.text).toContain('2 file(s) read, 2 skipped');
  });

  it('returns an error when nothing in the folder is readable', async () => {
    const { mcpManager } = fakeDrive({
      root: { name: 'Images', mimeType: FOLDER, children: ['img'] },
      img: { name: 'photo.jpg', mimeType: 'image/jpeg' },
    });
    const result = await resolveExternalReference(mcpManager, {
      source: 'drive',
      externalId: 'root',
      title: 'root',
      meta: { fileId: 'root', mimeType: FOLDER },
    });
    expect(result.text).toBe('');
    expect(result.error).toContain('photo.jpg');
  });

  it('looks up a pasted folder link by name without reading its files', async () => {
    const { mcpManager, callTool } = fakeDrive({
      root: { name: 'Proposal', mimeType: FOLDER, children: ['a'] },
      a: { name: 'Brief', mimeType: DOC, content: 'brief text' },
    });
    const item = await lookupExternalReferenceFromUrl(
      mcpManager,
      'https://drive.google.com/drive/folders/root'
    );
    expect(item).toMatchObject({ title: 'Proposal', meta: { mimeType: FOLDER } });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
