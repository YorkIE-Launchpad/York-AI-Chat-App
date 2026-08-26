/**
 * Pure graph edits for workflow pipelines (linear helpers + freeform canvas ops).
 */
import type {
  WorkflowAgentNode,
  WorkflowApprovalNode,
  WorkflowGraph,
  WorkflowInputField,
  WorkflowInputNode,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowNotifyNode,
  WorkflowToolNode,
} from './workflows';
import {
  WORKFLOW_SCHEMA_VERSION,
  defaultWorkflowInputFields,
  topologicalOrder,
  wouldCreateCycle,
} from './workflows';

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

function nextIdForPrefix(nodes: WorkflowNode[], prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  for (const n of nodes) {
    const m = re.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}_${max + 1}`;
}

function nextAgentId(nodes: WorkflowNode[]): string {
  return nextIdForPrefix(nodes, 'agent');
}

function successors(graph: WorkflowGraph, fromId: string): string[] {
  return graph.edges.filter((e) => e.from === fromId).map((e) => e.to);
}

function predecessors(graph: WorkflowGraph, toId: string): string[] {
  return graph.edges.filter((e) => e.to === toId).map((e) => e.from);
}

export function setNodePosition(
  graph: WorkflowGraph,
  nodeId: string,
  x: number,
  y: number
): WorkflowGraph {
  const g = cloneGraph(graph);
  const idx = g.nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) throw new Error(`Node not found: ${nodeId}`);
  g.nodes[idx] = { ...g.nodes[idx], x, y };
  return g;
}

/**
 * Add a non-trigger node at an optional position.
 * Optionally auto-connect from `connectFromId` when provided.
 */
export function addNode(
  graph: WorkflowGraph,
  type: Exclude<WorkflowNodeType, 'trigger'>,
  options?: {
    position?: { x: number; y: number };
    connectFromId?: string | null;
    label?: string;
    prompt?: string;
    toolName?: string;
    message?: string;
    fields?: WorkflowInputField[];
  }
): WorkflowGraph {
  const g = cloneGraph(graph);
  const x = options?.position?.x ?? 240 + g.nodes.length * 40;
  const y = options?.position?.y ?? 80 + (g.nodes.length % 3) * 40;

  let node: WorkflowNode;
  if (type === 'agent') {
    const agent: WorkflowAgentNode = {
      id: nextAgentId(g.nodes),
      type: 'agent',
      label: options?.label?.trim() || 'New agent step',
      prompt:
        options?.prompt?.trim() ||
        'Describe what this agent step should do. Prefer connected company tools.',
      x,
      y,
    };
    node = agent;
  } else if (type === 'tool') {
    const tool: WorkflowToolNode = {
      id: nextIdForPrefix(g.nodes, 'tool'),
      type: 'tool',
      label: options?.label?.trim() || 'Tool step',
      toolName: options?.toolName?.trim() || '',
      x,
      y,
    };
    node = tool;
  } else if (type === 'approval') {
    const approval: WorkflowApprovalNode = {
      id: nextIdForPrefix(g.nodes, 'approval'),
      type: 'approval',
      label: options?.label?.trim() || 'Approval',
      message: options?.message?.trim() || 'Approve before continuing this workflow?',
      requireApproval: true,
      x,
      y,
    };
    node = approval;
  } else if (type === 'input') {
    const input: WorkflowInputNode = {
      id: nextIdForPrefix(g.nodes, 'input'),
      type: 'input',
      label: options?.label?.trim() || 'Input',
      prompt:
        options?.prompt?.trim() || 'Provide the information needed to continue.',
      fields:
        options?.fields && options.fields.length > 0
          ? options.fields
          : defaultWorkflowInputFields(),
      x,
      y,
    };
    node = input;
  } else {
    const notify: WorkflowNotifyNode = {
      id: nextIdForPrefix(g.nodes, 'notify'),
      type: 'notify',
      label: options?.label?.trim() || 'Notify',
      message: options?.message?.trim() || 'Workflow step completed.',
      x,
      y,
    };
    node = notify;
  }

  g.nodes.push(node);
  const fromId = options?.connectFromId;
  if (fromId && g.nodes.some((n) => n.id === fromId)) {
    return connectNodes(g, fromId, node.id);
  }
  return g;
}

/** Connect two nodes; rejects self-loops, missing nodes, duplicate edges, and cycles. */
export function connectNodes(graph: WorkflowGraph, fromId: string, toId: string): WorkflowGraph {
  if (fromId === toId) throw new Error('Cannot connect a node to itself');
  const g = cloneGraph(graph);
  if (!g.nodes.some((n) => n.id === fromId)) throw new Error(`Node not found: ${fromId}`);
  if (!g.nodes.some((n) => n.id === toId)) throw new Error(`Node not found: ${toId}`);
  if (g.edges.some((e) => e.from === fromId && e.to === toId)) {
    return g;
  }
  if (wouldCreateCycle(g, fromId, toId)) {
    throw new Error('Connection would create a cycle');
  }
  const toNode = g.nodes.find((n) => n.id === toId);
  if (toNode?.type === 'trigger') {
    throw new Error('Cannot connect into the trigger node');
  }
  g.edges.push({ id: `e_${fromId}_${toId}`, from: fromId, to: toId });
  return g;
}

export function disconnectEdge(graph: WorkflowGraph, edgeId: string): WorkflowGraph {
  const g = cloneGraph(graph);
  g.edges = g.edges.filter((e) => e.id !== edgeId);
  return g;
}

export function disconnectBetween(
  graph: WorkflowGraph,
  fromId: string,
  toId: string
): WorkflowGraph {
  const g = cloneGraph(graph);
  g.edges = g.edges.filter((e) => !(e.from === fromId && e.to === toId));
  return g;
}

/**
 * Remove any non-trigger node and reconnect predecessors → successors.
 * Guard: if removing an agent and it is the last agent, still allow if other
 * executable nodes remain (tool/approval/notify). Prefer removeAgentNode for
 * the stricter “at least one agent” rule used by linear editor.
 */
export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  const g = cloneGraph(graph);
  const node = g.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.type === 'trigger') throw new Error('Cannot remove the trigger node');

  const preds = predecessors(g, nodeId);
  const succs = successors(g, nodeId);
  g.nodes = g.nodes.filter((n) => n.id !== nodeId);
  g.edges = g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  for (const p of preds) {
    for (const s of succs) {
      if (!g.edges.some((e) => e.from === p && e.to === s) && !wouldCreateCycle(g, p, s)) {
        g.edges.push({ id: `e_${p}_${s}`, from: p, to: s });
      }
    }
  }
  g.nodes = nodesInTopoOrder(g);
  return g;
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
    toolName?: string;
    /** null clears args; empty object is also omitted. */
    args?: Record<string, unknown> | null;
    /** Replace input-step fields when provided. */
    inputFields?: WorkflowInputField[];
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
  } else if (node.type === 'tool') {
    const next: WorkflowToolNode = { ...node };
    if (fields.label !== undefined) next.label = fields.label.trim() || next.label;
    if (fields.toolName !== undefined) {
      const name = fields.toolName.trim();
      if (name) next.toolName = name;
    }
    if (fields.args === null) {
      delete next.args;
    } else if (fields.args !== undefined) {
      const keys = Object.keys(fields.args);
      if (keys.length === 0) {
        delete next.args;
      } else {
        next.args = fields.args;
      }
    }
    g.nodes[idx] = next;
  } else if (node.type === 'approval' && fields.message !== undefined) {
    g.nodes[idx] = { ...node, message: fields.message };
    if (fields.label !== undefined) {
      g.nodes[idx] = { ...g.nodes[idx], label: fields.label.trim() || node.label };
    }
  } else if (node.type === 'input') {
    const next: WorkflowInputNode = { ...node };
    if (fields.label !== undefined) next.label = fields.label.trim() || next.label;
    if (fields.prompt !== undefined) next.prompt = fields.prompt;
    if (fields.inputFields !== undefined) {
      next.fields =
        fields.inputFields.length > 0 ? fields.inputFields : defaultWorkflowInputFields();
    }
    g.nodes[idx] = next;
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

/** Format input-step answers as a handoff summary for later agent prompts. */
export function formatInputAnswersSummary(
  answers: Record<string, string>,
  fields?: WorkflowInputField[]
): string {
  const lines: string[] = [];
  const labelByKey = new Map((fields || []).map((f) => [f.key, f.label]));
  for (const [key, value] of Object.entries(answers)) {
    const label = labelByKey.get(key) || key;
    const text = String(value ?? '').trim();
    if (!text) continue;
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n');
}

/**
 * Collect successful agent + input step results for handoff into later prompts.
 * (Name kept for compatibility; also includes input answers.)
 */
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
    if (s.status !== 'success') continue;
    if (s.type === 'input') {
      let summary = (s.summary || '').trim();
      if (s.output && typeof s.output === 'object' && s.output !== null) {
        const o = s.output as {
          summary?: unknown;
          answers?: unknown;
          fields?: unknown;
        };
        if (o.answers && typeof o.answers === 'object' && !Array.isArray(o.answers)) {
          const answers = o.answers as Record<string, string>;
          const fields = Array.isArray(o.fields)
            ? (o.fields as WorkflowInputField[])
            : undefined;
          const formatted = formatInputAnswersSummary(answers, fields);
          if (formatted) summary = formatted;
        } else if (typeof o.summary === 'string' && o.summary.trim()) {
          summary = o.summary.trim();
        }
      }
      if (summary) {
        out.push({ label: s.label || s.nodeId, summary: summary.slice(0, 4000) });
      }
      continue;
    }
    if (s.type && s.type !== 'agent') continue;
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
