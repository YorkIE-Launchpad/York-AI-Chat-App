/**
 * Visual workflow schema (M4) — versioned graph JSON.
 */

import type { CheckpointRun } from './orchestration';
import type {
  SessionDivisionFields,
  WorkspaceDivisionKind,
} from './workspace-division';
import {
  normalizeSessionDivision,
  projectDisplayName,
} from './workspace-division';

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
  /** Provider for locked model (e.g. openrouter, anthropic). */
  provider?: string;
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

/** Workspace binding on a workflow (where agent-step chats are created). */
export type WorkflowBinding = SessionDivisionFields;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  graph: WorkflowGraph;
  /** Optional linked scheduled task id when cron trigger is materialized. */
  scheduleTaskId: string | null;
  /** Workspace where run chats appear (default general). */
  division: WorkspaceDivisionKind;
  hubProjectId: string | null;
  hubProjectName: string | null;
  launchpadProjectId: number | null;
  launchpadProjectName: string | null;
  folderId: string | null;
  folderName: string | null;
  canonicalKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowDefinitionInput {
  name: string;
  description?: string;
  status?: WorkflowStatus;
  graph: WorkflowGraph;
  division?: WorkspaceDivisionKind;
  hubProjectId?: string | null;
  hubProjectName?: string | null;
  launchpadProjectId?: number | null;
  launchpadProjectName?: string | null;
  folderId?: string | null;
  folderName?: string | null;
  canonicalKey?: string | null;
}

export type WorkflowBindingUpdate = Partial<WorkflowBinding>;

/** Max length for stored workflow display titles. */
export const WORKFLOW_TITLE_MAX_LENGTH = 60;

/** Marker used when a schedule task materializes a workflow cron trigger. */
export const WORKFLOW_SCHEDULE_PROMPT_PREFIX = '[[YORK_WORKFLOW_RUN]]';

/** Marker embedded in agent-node prompts while a workflow is executing. */
export const WORKFLOW_AGENT_STEP_MARKER = '[[YORK_WORKFLOW_AGENT_STEP]]';

/** Session titles created for workflow agent steps (legacy prefix `Workflow:` also matches). */
export const WORKFLOW_SESSION_TITLE_PREFIX = 'Workflow run · ';

export function buildWorkflowTitle(raw: string, maxLength = WORKFLOW_TITLE_MAX_LENGTH): string {
  let text = raw
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(workflow|draft|automate|automation)[:\s-]+/i, '')
    .trim();
  if (!text) text = 'Untitled workflow';
  if (text.length > maxLength) {
    text = `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  }
  return text;
}

export function normalizeWorkflowBinding(
  input?: Partial<WorkflowBinding> | null
): WorkflowBinding {
  return normalizeSessionDivision(input ?? { division: 'general' });
}

/** sessionManager.startSession options from a workflow definition. */
export function workflowBindingToStartOptions(def: Pick<WorkflowDefinition, keyof WorkflowBinding>): {
  division: WorkspaceDivisionKind;
  hubProjectId: string | null;
  hubProjectName: string | null;
  launchpadProjectId: number | null;
  launchpadProjectName: string | null;
  folderId: string | null;
  folderName: string | null;
  canonicalKey: string | null;
} {
  const binding = normalizeWorkflowBinding(def);
  return {
    division: binding.division,
    hubProjectId: binding.hubProjectId ?? null,
    hubProjectName: binding.hubProjectName ?? null,
    launchpadProjectId: binding.launchpadProjectId ?? null,
    launchpadProjectName: binding.launchpadProjectName ?? null,
    folderId: binding.folderId ?? null,
    folderName: binding.folderName ?? null,
    canonicalKey: binding.canonicalKey ?? null,
  };
}

export function formatWorkflowSessionTitle(
  workflowName: string,
  stepLabel?: string | null
): string {
  const name = buildWorkflowTitle(workflowName || 'Untitled workflow');
  const step = (stepLabel || '').trim();
  if (!step || /^agent step/i.test(step)) {
    return `${WORKFLOW_SESSION_TITLE_PREFIX}${name}`;
  }
  const shortStep = step.length > 28 ? `${step.slice(0, 27)}…` : step;
  return `${WORKFLOW_SESSION_TITLE_PREFIX}${name} · ${shortStep}`;
}

export function workflowWorkspaceLabel(def: Pick<WorkflowDefinition, keyof WorkflowBinding>): string {
  const b = normalizeWorkflowBinding(def);
  if (b.division === 'project') {
    return projectDisplayName({
      hubProjectName: b.hubProjectName,
      launchpadProjectName: b.launchpadProjectName,
      hubProjectId: b.hubProjectId,
      launchpadProjectId: b.launchpadProjectId,
    });
  }
  if (b.division === 'folder') return b.folderName || 'Folder';
  if (b.division === 'hub') return 'Hub';
  return 'General';
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

/**
 * Initial run timeline in pipeline (topological) order — not raw nodes[] array order.
 * Newly inserted agents may sit at the end of nodes[]; edges define true pipeline order.
 */
export function buildInitialRunSteps(graph: WorkflowGraph | WorkflowNode[]): WorkflowRunStep[] {
  if (Array.isArray(graph)) {
    return graph.map((node) => stepFromNode(node));
  }
  const order = topologicalOrder(graph);
  if (order.length !== graph.nodes.length) {
    return graph.nodes.map((node) => stepFromNode(node));
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return order.map((id) => stepFromNode(byId.get(id)!));
}

function stepFromNode(node: WorkflowNode): WorkflowRunStep {
  return {
    nodeId: node.id,
    label: node.label || node.type,
    type: node.type,
    status: node.type === 'trigger' ? ('skipped' as const) : ('pending' as const),
    summary: node.type === 'trigger' ? 'Trigger (start)' : undefined,
  };
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

/** Marker block — constants defined above with buildWorkflowTitle helpers. */

export function formatWorkflowSchedulePrompt(workflowId: string, name: string): string {
  return `${WORKFLOW_SCHEDULE_PROMPT_PREFIX} id=${workflowId}\nRun workflow: ${name}`;
}

/** Returns workflow id when prompt is a schedule-linked workflow run, else null. */
export function parseWorkflowSchedulePrompt(prompt: string): string | null {
  const match = prompt.trim().match(/^\[\[YORK_WORKFLOW_RUN\]\]\s+id=([^\s\n]+)/);
  return match?.[1] ?? null;
}

/**
 * True when this session is executing a workflow node (not authoring a new one).
 * Authoring tools (propose/list) must not be injected in this mode.
 */
export function isWorkflowAgentExecutionContext(input: {
  title?: string | null;
  prompt?: string | null;
}): boolean {
  const title = input.title?.trim() || '';
  if (
    title.startsWith(WORKFLOW_SESSION_TITLE_PREFIX) ||
    title.startsWith('Workflow:') ||
    /^Workflow run\b/i.test(title)
  ) {
    return true;
  }
  const prompt = input.prompt || '';
  return prompt.includes(WORKFLOW_AGENT_STEP_MARKER);
}

/**
 * Kahns-style topological order. When a cycle exists, returns a partial order
 * (length < nodes.length) — callers should check with hasGraphCycle / order completeness.
 */
export function topologicalOrderStrict(graph: WorkflowGraph): string[] {
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
  return order;
}

/** True when edges form a cycle (not a DAG). */
export function hasGraphCycle(graph: WorkflowGraph): boolean {
  if (graph.nodes.length === 0) return false;
  return topologicalOrderStrict(graph).length !== graph.nodes.length;
}

/**
 * Would adding from→to create a cycle? (Assumes graph is currently a DAG.)
 * Also true if from === to.
 */
export function wouldCreateCycle(graph: WorkflowGraph, from: string, to: string): boolean {
  if (from === to) return true;
  // Reachability: if we can already walk to → ... → from, then from→to closes a cycle.
  const outs = new Map<string, string[]>();
  for (const n of graph.nodes) outs.set(n.id, []);
  for (const e of graph.edges) {
    if (!outs.has(e.from) || !outs.has(e.to)) continue;
    outs.get(e.from)!.push(e.to);
  }
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of outs.get(id) || []) stack.push(next);
  }
  return false;
}

export function topologicalOrder(graph: WorkflowGraph): string[] {
  const order = topologicalOrderStrict(graph);
  // Fall back to node list if cycle
  if (order.length !== graph.nodes.length) {
    return graph.nodes.map((n) => n.id);
  }
  return order;
}
