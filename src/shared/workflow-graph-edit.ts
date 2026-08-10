/**
 * Pure linear-graph edits for workflow pipelines (insert/remove/update agent nodes).
 */
import type { WorkflowAgentNode, WorkflowGraph, WorkflowNode } from './workflows';
import { WORKFLOW_SCHEMA_VERSION, topologicalOrder } from './workflows';

function nodesInTopoOrder(graph: WorkflowGraph): WorkflowNode[] {
  const order = topologicalOrder(graph);
  if (order.length !== graph.nodes.length) return graph.nodes;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    nodes: graph.nodes.map((n) => ({ ...n })),
    edges: graph.edges.map((e) => ({ ...e })),
  };
}

function nextAgentId(nodes: WorkflowNode[]): string {
  let max = 0;
  for (const n of nodes) {
    const m = /^agent_(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `agent_${max + 1}`;
}

function successors(graph: WorkflowGraph, fromId: string): string[] {
  return graph.edges.filter((e) => e.from === fromId).map((e) => e.to);
}

function predecessors(graph: WorkflowGraph, toId: string): string[] {
  return graph.edges.filter((e) => e.to === toId).map((e) => e.from);
}

/** Insert a new agent after `afterNodeId`, rewiring linear edges. */
export function insertAgentAfter(
  graph: WorkflowGraph,
  afterNodeId: string,
  partial?: Partial<Pick<WorkflowAgentNode, 'label' | 'prompt' | 'model' | 'provider'>>
): WorkflowGraph {
  const g = cloneGraph(graph);
  if (!g.nodes.some((n) => n.id === afterNodeId)) {
    throw new Error(`Node not found: ${afterNodeId}`);
  }
  const id = nextAgentId(g.nodes);
  const after = g.nodes.find((n) => n.id === afterNodeId)!;
  const agent: WorkflowAgentNode = {
    id,
    type: 'agent',
    label: partial?.label?.trim() || 'New agent step',
    prompt:
      partial?.prompt?.trim() ||
      'Describe what this agent step should do. Prefer connected company tools.',
    model: partial?.model,
    provider: partial?.provider,
    x: (after.x ?? 240) + 200,
    y: after.y ?? 80,
  };
  const outs = g.edges.filter((e) => e.from === afterNodeId);
  // Remove edges leaving afterNode; reconnect via new agent
  g.edges = g.edges.filter((e) => e.from !== afterNodeId);
  g.edges.push({ id: `e_${afterNodeId}_${id}`, from: afterNodeId, to: id });
  for (const e of outs) {
    g.edges.push({ id: `e_${id}_${e.to}`, from: id, to: e.to });
  }

  // Insert into nodes[] immediately after afterNodeId so array order matches pipeline
  const afterIdx = g.nodes.findIndex((n) => n.id === afterNodeId);
  if (afterIdx >= 0) {
    g.nodes.splice(afterIdx + 1, 0, agent);
  } else {
    g.nodes.push(agent);
  }
  g.nodes = nodesInTopoOrder(g);
  return g;
}

export function updateNodeFields(
  graph: WorkflowGraph,
  nodeId: string,
  fields: {
    label?: string;
    prompt?: string;
    model?: string | null;
    provider?: string | null;
    message?: string;
  }
): WorkflowGraph {
  const g = cloneGraph(graph);
  const idx = g.nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) throw new Error(`Node not found: ${nodeId}`);
  const node = g.nodes[idx];
  if (node.type === 'agent') {
    const next: WorkflowAgentNode = { ...node };
    if (fields.label !== undefined) next.label = fields.label.trim() || next.label;
    if (fields.prompt !== undefined) next.prompt = fields.prompt;
    if (fields.model === null) {
      delete next.model;
    } else if (fields.model !== undefined) {
      next.model = fields.model.trim() || undefined;
    }
    if (fields.provider === null) {
      delete next.provider;
    } else if (fields.provider !== undefined) {
      next.provider = fields.provider.trim() || undefined;
    }
    g.nodes[idx] = next;
  } else if (node.type === 'approval' && fields.message !== undefined) {
    g.nodes[idx] = { ...node, message: fields.message };
    if (fields.label !== undefined) {
      g.nodes[idx] = { ...g.nodes[idx], label: fields.label.trim() || node.label };
    }
  } else if (node.type === 'notify' && fields.message !== undefined) {
    g.nodes[idx] = { ...node, message: fields.message };
    if (fields.label !== undefined) {
      g.nodes[idx] = { ...g.nodes[idx], label: fields.label.trim() || node.label };
    }
  } else if (fields.label !== undefined) {
    g.nodes[idx] = { ...node, label: fields.label.trim() || node.label };
  }
  return g;
}

/**
 * Remove an agent node and reconnect predecessors → successors.
 * Does not remove the last remaining non-trigger executable node if it would leave only a trigger.
 */
export function removeAgentNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  const g = cloneGraph(graph);
  const node = g.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.type !== 'agent') throw new Error('Only agent nodes can be removed this way');

  const agents = g.nodes.filter((n) => n.type === 'agent');
  if (agents.length <= 1) {
    throw new Error('Cannot remove the only agent step');
  }

  const preds = predecessors(g, nodeId);
  const succs = successors(g, nodeId);
  g.nodes = g.nodes.filter((n) => n.id !== nodeId);
  g.edges = g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  for (const p of preds) {
    for (const s of succs) {
      const id = `e_${p}_${s}`;
      if (!g.edges.some((e) => e.from === p && e.to === s)) {
        g.edges.push({ id, from: p, to: s });
      }
    }
  }
  g.nodes = nodesInTopoOrder(g);
  return g;
}

/** Split agent prompt into two sequential agents (first half + second half). */
export function splitAgentPrompt(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== 'agent') {
    throw new Error('Can only split agent nodes');
  }
  const parts = node.prompt
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    const mid = Math.floor(node.prompt.length / 2);
    const a = node.prompt.slice(0, mid).trim();
    const b = node.prompt.slice(mid).trim();
    if (!a || !b) throw new Error('Prompt is too short to split');
    let g = updateNodeFields(graph, nodeId, {
      prompt: a,
      label: node.label || 'Agent step 1',
    });
    g = insertAgentAfter(g, nodeId, {
      label: 'Agent step 2',
      prompt: b,
      model: node.model,
      provider: node.provider,
    });
    return g;
  }
  let g = updateNodeFields(graph, nodeId, {
    prompt: parts[0],
    label: node.label || 'Agent step 1',
  });
  let after = nodeId;
  for (let i = 1; i < parts.length && i < 5; i += 1) {
    g = insertAgentAfter(g, after, {
      label: `Agent step ${i + 1}`,
      prompt: parts[i],
      model: node.model,
      provider: node.provider,
    });
    const inserted = g.nodes.find(
      (n) => n.type === 'agent' && n.prompt === parts[i] && n.id !== nodeId
    );
    after = inserted?.id || after;
  }
  return g;
}

export function buildPriorResultsPromptBlock(
  priors: Array<{ label: string; summary: string }>,
  maxTotal = 6000
): string {
  if (!priors.length) return '';
  const lines = ['## Prior step results (for context; do not re-do completed work)'];
  let used = lines[0].length;
  for (const p of priors) {
    const chunk = `\n### ${p.label}\n${p.summary.trim()}`;
    if (used + chunk.length > maxTotal) {
      const room = Math.max(0, maxTotal - used - 40);
      if (room > 80) {
        lines.push(`\n### ${p.label}\n${p.summary.trim().slice(0, room)}…`);
      }
      break;
    }
    lines.push(chunk);
    used += chunk.length;
  }
  return lines.join('');
}

export function composeAgentStepPrompt(
  staticPrompt: string,
  priors: Array<{ label: string; summary: string }>
): string {
  const block = buildPriorResultsPromptBlock(priors);
  if (!block) return staticPrompt;
  return `${staticPrompt.trim()}\n\n${block}`;
}

export function sessionIdsFromWorkflowRun(payload: {
  sessionId?: unknown;
  steps?: unknown;
}): string[] {
  const ids: string[] = [];
  if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) {
    ids.push(payload.sessionId.trim());
  }
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const output = (s as { output?: unknown }).output;
    if (output && typeof output === 'object' && output !== null) {
      const sid = (output as { sessionId?: unknown }).sessionId;
      if (typeof sid === 'string' && sid.trim()) ids.push(sid.trim());
    }
  }
  return Array.from(new Set(ids));
}

export function extractPriorAgentResults(
  steps: Array<{
    nodeId: string;
    label?: string;
    type?: string;
    status?: string;
    summary?: string;
    output?: unknown;
  }>
): Array<{ label: string; summary: string }> {
  const out: Array<{ label: string; summary: string }> = [];
  for (const s of steps) {
    if (s.type && s.type !== 'agent') continue;
    if (s.status !== 'success') continue;
    let summary = (s.summary || '').trim();
    if (s.output && typeof s.output === 'object' && s.output !== null) {
      const o = s.output as { summary?: unknown };
      if (typeof o.summary === 'string' && o.summary.trim()) {
        summary = o.summary.trim();
      }
    }
    if (!summary || /^(Agent step finished|Running )/i.test(summary)) continue;
    out.push({ label: s.label || s.nodeId, summary: summary.slice(0, 4000) });
  }
  return out;
}
