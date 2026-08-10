/**
 * Agent tools: wiki_search, wiki_read, wiki_list.
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { WikiService } from './wiki-service';

export function createWikiTools(wikiService: WikiService): AgentRuntimeCustomTool[] {
  const searchTool: AgentRuntimeCustomTool = {
    name: 'wiki_search',
    label: 'wiki_search',
    description:
      'Search the company memory wiki (compressed Matter, meetings, connector pages). Prefer this before raw connector dumps for status/brief questions.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: 'What to look up in the wiki.' }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const query = String((params as { query?: string }).query || '');
      const limit = (params as { limit?: number }).limit;
      const results = wikiService.search(query, limit);
      if (!results.length) {
        return {
          content: [{ type: 'text' as const, text: 'No wiki pages matched that query.' }],
          details: undefined,
        };
      }
      const lines = results.map((r) =>
        [
          `- id: ${r.id}`,
          `  path: ${r.path}`,
          `  title: ${r.title}`,
          `  score: ${r.score}`,
          `  excerpt: ${r.excerpt}`,
        ].join('\n')
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: [`Found ${results.length} wiki page(s):`, ...lines].join('\n\n'),
          },
        ],
        details: undefined,
      };
    },
  };

  const readTool: AgentRuntimeCustomTool = {
    name: 'wiki_read',
    label: 'wiki_read',
    description: 'Read a wiki page by id or path (from wiki_search / wiki_list).',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'Page id from wiki_search.' })),
      path: Type.Optional(Type.String({ description: 'Page path, e.g. clients/acme.' })),
    }),
    async execute(_toolCallId, params) {
      const id = (params as { id?: string }).id;
      const pagePath = (params as { path?: string }).path;
      const page = id
        ? wikiService.get(id)
        : pagePath
          ? wikiService.getByPath(pagePath)
          : null;
      if (!page) {
        return {
          content: [{ type: 'text' as const, text: 'Wiki page not found.' }],
          details: undefined,
        };
      }
      const text = [
        `id: ${page.id}`,
        `path: ${page.path}`,
        `title: ${page.title}`,
        `score: ${page.score}`,
        `updatedAt: ${new Date(page.updatedAt).toISOString()}`,
        `sources: ${JSON.stringify(page.sources)}`,
        '',
        page.body,
      ].join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        details: undefined,
      };
    },
  };

  const listTool: AgentRuntimeCustomTool = {
    name: 'wiki_list',
    label: 'wiki_list',
    description: 'List memory wiki pages (path/title). Optional pathPrefix filters to a folder.',
    parameters: Type.Object({
      pathPrefix: Type.Optional(
        Type.String({ description: 'Folder prefix, e.g. clients or projects.' })
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params) {
      const prefix = String((params as { pathPrefix?: string }).pathPrefix || '')
        .trim()
        .replace(/^\/+|\/+$/g, '');
      const limit = (params as { limit?: number }).limit ?? 50;
      let pages = wikiService.list(Math.max(limit, 100));
      if (prefix) {
        pages = pages.filter((p) => p.path === prefix || p.path.startsWith(`${prefix}/`));
      }
      pages = pages.slice(0, limit);
      if (!pages.length) {
        return {
          content: [{ type: 'text' as const, text: 'No wiki pages found.' }],
          details: undefined,
        };
      }
      const lines = pages.map((p) => `- ${p.path} — ${p.title} (id: ${p.id})`);
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: undefined,
      };
    },
  };

  return [searchTool, readTool, listTool];
}
