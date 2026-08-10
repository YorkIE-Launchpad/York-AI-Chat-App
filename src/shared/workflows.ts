/**
 * Visual workflow schema (M4) — versioned graph JSON.
 */

import type { CheckpointRun } from './orchestration';

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export type WorkflowNodeType = 'trigger' | 'agent' | 'tool' | 'approval' | 'notify';

export type WorkflowTriggerKind = 'cron' | 'channel' | 'manual';

export interface WorkflowNodeBase {
  id: string;
  type: WorkflowNodeType;
  label: string;
  /** Lightweight canvas position. */
  x?: number;
  y?: number;
}

export interface WorkflowTriggerNode extends WorkflowNodeBase {
  type: 'trigger';
  trigger: WorkflowTriggerKind;
  /** Cron-like: weekday hours or interval description (human + schedule payload). */
  cron?: {
    times?: string[];
    weekdays?: number[];
    intervalMs?: number;
  };
  channel?: string;
}

export interface WorkflowAgentNode extends WorkflowNodeBase {
  type: 'agent';
  prompt: string;
  model?: string;
}

export interface WorkflowToolNode extends WorkflowNodeBase {
  type: 'tool';
  toolName: string;
  args?: Record<string, unknown>;
}

export interface WorkflowApprovalNode extends WorkflowNodeBase {
  type: 'approval';
  message: string;
  /** Always gate — never auto-skip. */
  requireApproval: true;
}

export interface WorkflowNotifyNode extends WorkflowNodeBase {
  type: 'notify';
  channel?: string;
  message: string;
}

export type WorkflowNode =
  | WorkflowTriggerNode
  | WorkflowAgentNode
  | WorkflowToolNode
  | WorkflowApprovalNode
  | WorkflowNotifyNode;

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
}

export interface WorkflowGraph {
  version: typeof WORKFLOW_SCHEMA_VERSION;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type WorkflowStatus = 'draft' | 'enabled' | 'disabled';

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  graph: WorkflowGraph;
  /** Optional linked scheduled task id when cron trigger is materialized. */
  scheduleTaskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowDefinitionInput {
  name: string;
  description?: string;
  status?: WorkflowStatus;
  graph: WorkflowGraph;
}

export type WorkflowRunStepStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'awaiting_approval';

/** One node on a durable workflow run timeline (stored in checkpoint payload.steps). */
export interface WorkflowRunStep {
  nodeId: string;
  label: string;
  type: WorkflowNodeType;
  status: WorkflowRunStepStatus;
  summary?: string;
  output?: unknown;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface WorkflowRunSummary {
  run: CheckpointRun;
  workflowId: string;
  workflowName: string;
}

/** Progress push payload for live UI refresh. */
export interface WorkflowRunProgressEvent {
  runId: string;
  workflowId: string;
  status: CheckpointRun['status'];
  stepId: string;
  steps?: WorkflowRunStep[];
}

export type WorkflowRunDisplayStatus =
  | CheckpointRun['status']
  | 'needs_approval';

export function isWorkflowRunTerminal(status: CheckpointRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function resolveWorkflowRunDisplayStatus(
  status: CheckpointRun['status']
): WorkflowRunDisplayStatus {
  if (status === 'paused_for_approval') return 'needs_approval';
  return status;
}

export function workflowRunDisplayLabel(status: WorkflowRunDisplayStatus): string {
  switch (status) {
    case 'needs_approval':
      return 'Needs approval';
    case 'paused_for_approval':
      return 'Needs approval';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'stuck':
      return 'Stuck';
    default:
      return status;
  }
}

export function getWorkflowRunSteps(payload: CheckpointRun['payload']): WorkflowRunStep[] {
  const raw = payload.steps;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is WorkflowRunStep =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as WorkflowRunStep).nodeId === 'string' &&
      typeof (s as WorkflowRunStep).status === 'string'
  );
}

export function buildInitialRunSteps(nodes: WorkflowNode[]): WorkflowRunStep[] {
  return nodes.map((node) => ({
    nodeId: node.id,
    label: node.label || node.type,
    type: node.type,
    status: node.type === 'trigger' ? ('skipped' as const) : ('pending' as const),
    summary: node.type === 'trigger' ? 'Trigger (start)' : undefined,
  }));
}

export function createEmptyWorkflowGraph(): WorkflowGraph {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    nodes: [
      {
        id: 'trigger_1',
        type: 'trigger',
        label: 'Trigger',
        trigger: 'manual',
        x: 40,
        y: 80,
      },
    ],
    edges: [],
  };
}

export function topologicalOrder(graph: WorkflowGraph): string[] {
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    out.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    out.get(edge.from)?.push(edge.to);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id) || []) {
      const nextDeg = (indegree.get(next) || 0) - 1;
      indegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }
  // Fall back to node list if cycle
  if (order.length !== graph.nodes.length) {
    return graph.nodes.map((n) => n.id);
  }
  return order;
}
