import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/tmp/york-ie-test-app',
  },
}));

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeBaseService } from '../../main/knowledge-base/knowledge-base-service';
import { createKnowledgeBaseTools } from '../../main/knowledge-base/knowledge-base-tools';
import { toKnowledgeMatchQuery } from '../../main/knowledge-base/knowledge-base-store';
import { chunkKnowledgeText } from '../../main/knowledge-base/knowledge-base-extract';

function toolText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

describe('knowledge base', () => {
  let rawDb: Database.Database;
  let tmpDir: string;
  let service: KnowledgeBaseService;
  const folders = new Map<string, string>();
  const changed = vi.fn();

  beforeEach(() => {
    rawDb = new Database(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
    folders.clear();
    changed.mockReset();
    service = new KnowledgeBaseService(rawDb, {
      resolveFolderId: (sessionId) => folders.get(sessionId) ?? null,
      onChanged: changed,
    });
  });

  afterEach(() => {
    rawDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, body: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, body);
    return filePath;
  }

  it('indexes a text file into the chat scope and finds it by keyword', async () => {
    const filePath = writeFile(
      'pricing.md',
      '# Pricing\n\nThe enterprise plan costs $4,800 per seat annually.\n\nSupport is 24/7.'
    );
    const source = await service.addFile({ scope: 'chat', scopeId: 's1' }, filePath);
    expect(source?.status).toBe('ready');
    expect(source?.chunkCount).toBe(1);

    const hits = service.search({ id: 's1' }, 'what does the enterprise plan cost?');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('pricing.md');
    expect(hits[0].excerpt).toContain('enterprise');
    expect(changed).toHaveBeenCalledWith({ scope: 'chat', scopeId: 's1' });
  });

  it('dedupes re-attached files by name and keeps chats isolated', async () => {
    const first = await service.addFile(
      { scope: 'chat', scopeId: 's1' },
      writeFile('notes.txt', 'alpha version')
    );
    const second = await service.addFile(
      { scope: 'chat', scopeId: 's1' },
      writeFile('notes.txt', 'beta version')
    );
    expect(second?.id).toBe(first?.id);
    expect(service.listForSession({ id: 's1' })).toHaveLength(1);
    expect(service.search({ id: 's1' }, 'alpha')).toHaveLength(0);
    expect(service.search({ id: 's1' }, 'beta')).toHaveLength(1);
    expect(service.search({ id: 's2' }, 'beta')).toHaveLength(0);
    expect(service.read({ id: 's2' }, first!.id)).toBeNull();
  });

  it('shares folder sources with every chat in the folder', async () => {
    folders.set('s1', 'f1');
    folders.set('s2', 'f1');
    await service.addFile(
      { scope: 'folder', scopeId: 'f1' },
      writeFile('handbook.txt', 'Vacation policy: 25 days per year.')
    );
    expect(service.listForSession({ id: 's2' })).toHaveLength(1);
    expect(service.search({ id: 's2' }, 'vacation policy')[0].scope).toBe('folder');
    expect(service.listForSession({ id: 's3' })).toHaveLength(0);
  });

  it('records an error for unsupported binary files', async () => {
    const filePath = path.join(tmpDir, 'blob.bin');
    fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3, 0, 255]));
    const source = await service.addFile({ scope: 'chat', scopeId: 's1' }, filePath);
    expect(source?.status).toBe('error');
    expect(service.buildPromptPrefix(service.listForSession({ id: 's1' }))).toBeUndefined();
  });

  it('skips images', async () => {
    const source = await service.addFile(
      { scope: 'chat', scopeId: 's1' },
      writeFile('photo.png', 'not really a png')
    );
    expect(source).toBeNull();
  });

  it('stores connector text supplied by the caller and refresh errors when the file is gone', async () => {
    const drive = await service.addReference(
      {
        scope: 'chat',
        scopeId: 's1',
        source: 'drive',
        externalId: 'abc',
        title: 'Roadmap',
        url: 'https://docs.google.com/abc',
      },
      'Q3 roadmap: launch the knowledge base feature.'
    );
    expect(drive.status).toBe('ready');
    expect(service.search({ id: 's1' }, 'roadmap launch')[0].sourceId).toBe(drive.id);

    const filePath = writeFile('temp.txt', 'temporary');
    const file = await service.addFile({ scope: 'chat', scopeId: 's1' }, filePath);
    fs.rmSync(filePath);
    const refreshed = await service.refresh(file!.id);
    expect(refreshed?.status).toBe('error');
  });

  it('exposes search/read tools scoped to the session', async () => {
    const body = Array.from({ length: 40 }, (_, i) =>
      i === 30
        ? 'The secret launch codename is BLUEBIRD.'
        : `Paragraph ${i} filler text about nothing.`
    ).join('\n\n');
    const source = await service.addFile(
      { scope: 'chat', scopeId: 's1' },
      writeFile('long.txt', body)
    );
    expect(source!.chunkCount).toBeGreaterThan(1);

    const [listTool, searchTool, readTool] = createKnowledgeBaseTools(service, { id: 's1' });
    expect(
      toolText(await listTool.execute('t', {}, undefined, undefined, undefined as never))
    ).toContain('long.txt');
    const searchText = toolText(
      await searchTool.execute('t', { query: 'codename' }, undefined, undefined, undefined as never)
    );
    expect(searchText).toContain('BLUEBIRD');
    const chunk = Number(/chunk: (\d+)/.exec(searchText)?.[1]);
    const readText = toolText(
      await readTool.execute(
        't',
        { id: source!.id, chunk, maxChars: 800 },
        undefined,
        undefined,
        undefined as never
      )
    );
    expect(readText).toContain('BLUEBIRD');

    const otherRead = createKnowledgeBaseTools(service, { id: 's2' })[2];
    expect(
      toolText(
        await otherRead.execute('t', { id: source!.id }, undefined, undefined, undefined as never)
      )
    ).toContain('not found');
  });

  it('builds a prompt prefix listing sources', async () => {
    await service.addFile({ scope: 'chat', scopeId: 's1' }, writeFile('a.md', 'hello world'));
    const prefix = service.buildPromptPrefix(service.listForSession({ id: 's1' }));
    expect(prefix).toContain('<knowledge_sources>');
    expect(prefix).toContain('a.md');
    expect(prefix).toContain('sources_search');
  });

  it('deleteScope removes chat sources', async () => {
    await service.addFile({ scope: 'chat', scopeId: 's1' }, writeFile('a.md', 'hello world'));
    service.deleteScope({ scope: 'chat', scopeId: 's1' });
    expect(service.listForSession({ id: 's1' })).toHaveLength(0);
    expect(service.search({ id: 's1' }, 'hello')).toHaveLength(0);
  });
});

describe('knowledge base helpers', () => {
  it('builds OR match queries without stop words', () => {
    expect(toKnowledgeMatchQuery('What is the refund policy?')).toBe('"refund"* OR "policy"*');
    expect(toKnowledgeMatchQuery('the a of')).toBe('');
  });

  it('chunks long text with overlap and no empty chunks', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const chunks = chunkKnowledgeText(text, 300, 50);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length > 0 && c.length <= 300)).toBe(true);
    expect(chunks.join(' ')).toContain('Sentence number 199.');
  });
});
