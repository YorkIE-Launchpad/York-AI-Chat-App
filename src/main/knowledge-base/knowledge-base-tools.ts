/**
 * Agent tools: sources_list, sources_search, sources_read (chat + folder knowledge base).
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { KnowledgeBaseService, KnowledgeSessionRef } from './knowledge-base-service';

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }], details: undefined };
}

export function createKnowledgeBaseTools(
  service: KnowledgeBaseService,
  session: KnowledgeSessionRef
): AgentRuntimeCustomTool[] {
  const listTool: AgentRuntimeCustomTool = {
    name: 'sources_list',
    label: 'sources_list',
    description:
      'List the knowledge base sources (files, uploads, Drive/Confluence/Jira/Slack docs) attached to this chat and its folder.',
    parameters: Type.Object({}),
    async execute() {
      const sources = service.listForSession(session);
      if (!sources.length) return text('This chat has no knowledge base sources.');
      const lines = sources.map((s) =>
        [
          `- id: ${s.id}`,
          `  title: ${s.title}`,
          `  kind: ${s.kind}${s.scope === 'folder' ? ' (folder)' : ''}`,
          `  status: ${s.status}${s.error ? ` — ${s.error}` : ''}`,
          `  chars: ${s.charCount}`,
          s.url ? `  url: ${s.url}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
      return text([`${sources.length} source(s):`, ...lines].join('\n\n'));
    },
  };

  const searchTool: AgentRuntimeCustomTool = {
    name: 'sources_search',
    label: 'sources_search',
    description:
      "Keyword search across this chat's knowledge base sources. Returns ranked passages with source ids. Use specific terms (names, numbers, topics); try synonyms if nothing matches.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: 'Keywords to look for.' }),
      sourceId: Type.Optional(Type.String({ description: 'Restrict to one source id.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const { query, sourceId, limit } = params as {
        query?: string;
        sourceId?: string;
        limit?: number;
      };
      const hits = service.search(session, String(query || ''), limit ?? 8, sourceId);
      if (!hits.length) {
        return text(
          'No passages matched. Try different keywords, or sources_read a source directly.'
        );
      }
      const lines = hits.map((hit) =>
        [
          `- source: ${hit.title} (id: ${hit.sourceId})`,
          `  chunk: ${hit.chunkIndex}`,
          `  excerpt: ${hit.excerpt.replace(/\s+/g, ' ').trim()}`,
        ].join('\n')
      );
      return text(
        [
          `Found ${hits.length} passage(s). Use sources_read with id + chunk for the full passage:`,
          ...lines,
        ].join('\n\n')
      );
    },
  };

  const readTool: AgentRuntimeCustomTool = {
    name: 'sources_read',
    label: 'sources_read',
    description:
      'Read the extracted text of a knowledge base source. Pass `chunk` (from sources_search) to read around a passage, or page through with `offset`.',
    parameters: Type.Object({
      id: Type.String({ description: 'Source id from sources_list / sources_search.' }),
      chunk: Type.Optional(
        Type.Integer({ minimum: 0, description: 'Chunk index to center the read on.' })
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Character offset.' })),
      maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 60000 })),
    }),
    async execute(_toolCallId, params) {
      const { id, chunk, offset, maxChars } = params as {
        id?: string;
        chunk?: number;
        offset?: number;
        maxChars?: number;
      };
      const sourceId = String(id || '');
      const size = maxChars ?? (chunk !== undefined ? 6000 : 20000);
      let start = offset ?? 0;
      if (chunk !== undefined && offset === undefined) {
        const chunkStart = service.chunkOffset(sourceId, chunk) ?? 0;
        start = Math.max(0, chunkStart - Math.floor(size / 4));
      }
      const result = service.read(session, sourceId, start, size);
      if (!result) return text('Source not found in this chat.');
      const end = result.offset + result.text.length;
      const header = [
        `title: ${result.source.title}`,
        `id: ${result.source.id}`,
        result.source.url ? `url: ${result.source.url}` : '',
        `range: ${result.offset}-${end} of ${result.total} chars`,
      ]
        .filter(Boolean)
        .join('\n');
      const more =
        end < result.total ? `\n\n[More text remains — call sources_read with offset ${end}]` : '';
      return text(`${header}\n\n${result.text}${more}`);
    },
  };

  return [listTool, searchTool, readTool];
}
