/**
 * Agent tools: summary_tree_stats, summary_tree_list, summary_tree_read.
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { SummaryTreeService } from './summary-tree-service';
import { kindLabel } from '../../shared/summary-tree';

export function createSummaryTreeTools(
  summaryTreeService: SummaryTreeService
): AgentRuntimeCustomTool[] {
  const statsTool: AgentRuntimeCustomTool = {
    name: 'summary_tree_stats',
    label: 'summary_tree_stats',
    description:
      'Stats for the hierarchical memory Summary Tree (Document → L2 → L1 → Source over wiki). Prefer when answering after Build Summary Trees.',
    parameters: Type.Object({}),
    async execute() {
      const stats = summaryTreeService.stats();
      const text = [
        `Summary Tree stats:`,
        `- nodes: ${stats.nodeCount}`,
        `- parent-child links: ${stats.linkCount}`,
        `- trees: ${stats.treeCount}`,
        `- documents: ${stats.documentCount}`,
        `- L2: ${stats.l2Count}`,
        `- L1: ${stats.l1Count}`,
        `- source leaves: ${stats.sourceCount}`,
        stats.nodeCount === 0
          ? 'Tree empty — user should run Build Summary Trees from Settings → Memory after wiki ingest.'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        details: stats,
      };
    },
  };

  const listTool: AgentRuntimeCustomTool = {
    name: 'summary_tree_list',
    label: 'summary_tree_list',
    description:
      'List summary tree nodes by kind (document, l2, l1, source). Use document/l2 first for high-level context.',
    parameters: Type.Object({
      kind: Type.Optional(
        Type.Union([
          Type.Literal('document'),
          Type.Literal('l2'),
          Type.Literal('l1'),
          Type.Literal('source'),
        ])
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params) {
      const kind = (params as { kind?: 'document' | 'l2' | 'l1' | 'source' }).kind || 'document';
      const limit = Math.min(50, Math.max(1, (params as { limit?: number }).limit ?? 15));
      const graph = summaryTreeService.getGraph({ includeSourceLeaves: kind === 'source' });
      const nodes = graph.nodes.filter((n) => n.kind === kind).slice(0, limit);
      if (!nodes.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No ${kindLabel(kind)} nodes. Build Summary Trees from Settings → Memory if wiki has pages.`,
            },
          ],
          details: undefined,
        };
      }
      const lines = nodes.map(
        (n) =>
          `- [${n.id}] ${kindLabel(n.kind)} · ${n.treeKey} · ${n.title} (score ${Math.round(n.score)})`
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: [`${kindLabel(kind)} nodes (${nodes.length}):`, ...lines].join('\n'),
          },
        ],
        details: { kind, count: nodes.length },
      };
    },
  };

  const readTool: AgentRuntimeCustomTool = {
    name: 'summary_tree_read',
    label: 'summary_tree_read',
    description: 'Read a summary tree node by id (from summary_tree_list).',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Node id' }),
    }),
    async execute(_toolCallId, params) {
      const id = String((params as { id: string }).id || '').trim();
      const node = summaryTreeService.getNode(id);
      if (!node) {
        return {
          content: [{ type: 'text' as const, text: `No summary tree node for id ${id}.` }],
          details: undefined,
        };
      }
      const text = [
        `# ${node.title}`,
        `kind: ${kindLabel(node.kind)} · tree: ${node.treeKey} · level: ${node.level}`,
        node.wikiPageId ? `wikiPageId: ${node.wikiPageId}` : '',
        '',
        node.body.slice(0, 6000),
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        details: { id: node.id, kind: node.kind, treeKey: node.treeKey },
      };
    },
  };

  return [statsTool, listTool, readTool];
}
