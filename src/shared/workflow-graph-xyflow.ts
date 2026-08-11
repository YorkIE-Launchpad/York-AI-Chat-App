/**
 * Pure WorkflowGraph ↔ xyflow-shaped DTOs (no React).
 * Renderer maps these onto @xyflow/react Node/Edge types.
 */

import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRunStepStatus,
} from './workflows';
import { WORKFLOW_SCHEMA_VERSION, topologicalOrder } from './workflows';

export const XYFLOW_NODE_TYPE = 'workflow' as const;

export interface FlowCanvasPosition {
  x: number;
  y: number;
}

/** Lightweight node shape compatible with @xyflow/react Node (minus measured size). */
export interface FlowCanvasNode {
  id: string;
  type: typeof XYFLOW_NODE_TYPE;
  position: FlowCanvasPosition;
  data: FlowCanvasNodeData;
  selected?: boolean;
}

export interface FlowCanvasNodeData {
  nodeType: WorkflowNodeType;
  label: string;
  summary: string;
  /** Optional live run status for overlay. */
  runStatus?: WorkflowRunStepStatus;
  [key: string]: unknown;
}

export interface FlowCanvasEdge {
  id: string;
  source: string;
  target: string;
  selectable?: boolean;
  deletable?: boolean;
}

export interface FlowCanvasGraph {
  nodes: FlowCanvasNode[];
  edges: FlowCanvasEdge[];
}

const LAYOUT_ORIGIN_X = 40;
const LAYOUT_ORIGIN_Y = 80;
const LAYOUT_GAP_X = 220;
const LAYOUT_GAP_Y = 120;

function nodeSummary(node: WorkflowNode): string {
  switch (node.type) {
    case 'trigger':
      if (node.trigger === 'cron' && node.cron?.times?.length) {
        const days =
          node.cron.weekdays && node.cron.weekdays.length
            ? ` · days ${node.cron.weekdays.join(',')}`
            : '';
        return `${node.cron.times.join(', ')}${days}`;
      }
      if (node.trigger === 'channel') return node.channel || 'Channel event';
      return 'Manual run';
    case 'agent':
      return node.prompt?.trim() || 'Agent step';
    case 'tool':
      return node.toolName || 'Tool';
    case 'approval':
      return node.message || 'Requires approval';
    case 'input': {
      const count = node.fields?.length ?? 0;
      const prompt = node.prompt?.trim();
      if (prompt) return prompt;
      return count === 1 ? '1 field' : `${count} fields`;
    }
    case 'notify':
      return node.message || 'Notify';
    default:
      return (node as WorkflowNode).label || (node as WorkflowNode).id;
  }
}

/** True when a node is missing canvas coordinates. */
export function graphNeedsAutoLayout(graph: WorkflowGraph): boolean {
  return graph.nodes.some((n) => n.x == null || n.y == null || Number.isNaN(n.x) || Number.isNaN(n.y));
}

/**
 * Left-to-right layout by topological order.
 * Fills missing x/y; does not reorder nodes[] beyond applying computed coords.
 */
export function autoLayoutLinear(graph: WorkflowGraph): WorkflowGraph {
  const order = topologicalOrder(graph);
  const orderedIds =
    order.length === graph.nodes.length ? order : graph.nodes.map((n) => n.id);

  // Layer by longest path from sources for slight fan-out vertical spread
  const indegree = new Map<string, number>();
  const outs = new Map<string, string[]>();
  for (const id of orderedIds) {
    indegree.set(id, 0);
    outs.set(id, []);
  }
  for (const e of graph.edges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
    outs.get(e.from)?.push(e.to);
  }
  const layer = new Map<string, number>();
  for (const id of orderedIds) {
    if ((indegree.get(id) || 0) === 0) layer.set(id, 0);
  }
  for (const id of orderedIds) {
    const col = layer.get(id) ?? 0;
    for (const next of outs.get(id) || []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, col + 1));
    }
  }

  const rowCursor = new Map<number, number>();
  const positions = new Map<string, FlowCanvasPosition>();
  for (const id of orderedIds) {
    const col = layer.get(id) ?? 0;
    const row = rowCursor.get(col) ?? 0;
    rowCursor.set(col, row + 1);
    positions.set(id, {
      x: LAYOUT_ORIGIN_X + col * LAYOUT_GAP_X,
      y: LAYOUT_ORIGIN_Y + row * LAYOUT_GAP_Y,
    });
  }

  return {
    version: WORKFLOW_SCHEMA_VERSION,
    nodes: graph.nodes.map((n) => {
      const pos = positions.get(n.id);
      return {
        ...n,
        x: n.x != null && !Number.isNaN(n.x) ? n.x : pos?.x ?? LAYOUT_ORIGIN_X,
        y: n.y != null && !Number.isNaN(n.y) ? n.y : pos?.y ?? LAYOUT_ORIGIN_Y,
      };
    }),
    edges: graph.edges.map((e) => ({ ...e })),
  };
}

/** Ensure every node has x/y (auto-layout only missing ones). */
export function ensureGraphPositions(graph: WorkflowGraph): WorkflowGraph {
  if (!graphNeedsAutoLayout(graph)) return graph;
  return autoLayoutLinear(graph);
}

export function workflowGraphToFlow(
  graph: WorkflowGraph,
  options?: {
    selectedNodeId?: string | null;
    stepStatusByNodeId?: Record<string, WorkflowRunStepStatus>;
  }
): FlowCanvasGraph {
  const laidOut = ensureGraphPositions(graph);
  const nodes: FlowCanvasNode[] = laidOut.nodes.map((n) => ({
    id: n.id,
    type: XYFLOW_NODE_TYPE,
    position: { x: n.x ?? LAYOUT_ORIGIN_X, y: n.y ?? LAYOUT_ORIGIN_Y },
    selected: options?.selectedNodeId === n.id,
    data: {
      nodeType: n.type,
      label: n.label || n.type,
      summary: nodeSummary(n),
      runStatus: options?.stepStatusByNodeId?.[n.id],
    },
  }));
  const edges: FlowCanvasEdge[] = laidOut.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    selectable: true,
    deletable: true,
  }));
  return { nodes, edges };
}

/**
 * Merge xyflow positions + edge list back into a WorkflowGraph,
 * preserving full node payloads from baseGraph.
 */
export function flowToWorkflowGraph(
  flowNodes: Array<{ id: string; position: FlowCanvasPosition }>,
  flowEdges: Array<{ id: string; source: string; target: string }>,
  baseGraph: WorkflowGraph
): WorkflowGraph {
  const posById = new Map(flowNodes.map((n) => [n.id, n.position]));
  const baseById = new Map(baseGraph.nodes.map((n) => [n.id, n]));

  const nodes: WorkflowNode[] = [];
  for (const flowNode of flowNodes) {
    const base = baseById.get(flowNode.id);
    if (!base) continue;
    const pos = posById.get(flowNode.id);
    nodes.push({
      ...base,
      x: pos?.x ?? base.x,
      y: pos?.y ?? base.y,
    });
  }
  // Keep any base nodes missing from flow (should not happen)
  for (const base of baseGraph.nodes) {
    if (!nodes.some((n) => n.id === base.id)) {
      nodes.push({ ...base });
    }
  }

  const edges: WorkflowEdge[] = flowEdges.map((e, i) => ({
    id: e.id || `e_${e.source}_${e.target}_${i}`,
    from: e.source,
    to: e.target,
  }));

  return {
    version: WORKFLOW_SCHEMA_VERSION,
    nodes,
    edges,
  };
}
