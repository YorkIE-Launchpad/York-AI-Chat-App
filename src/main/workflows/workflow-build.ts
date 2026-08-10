/**
 * Build + validate workflow graphs from natural language (OpenHuman-inspired).
 * York schema is smaller than tinyflows; we still author real structure:
 * short name, correct trigger, action steps, approval, optional notify.
 */
import type {
  WorkflowDefinitionInput,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowTriggerKind,
  WorkflowTriggerNode,
} from '../../shared/workflows';
import { WORKFLOW_AGENT_STEP_MARKER, WORKFLOW_SCHEMA_VERSION } from '../../shared/workflows';

export interface WorkflowBuildResult {
  input: WorkflowDefinitionInput;
  summary: string[];
  warnings: string[];
}

export class WorkflowGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowGraphValidationError';
  }
}

const WEEKDAY_MAP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/** Parse HH:MM from phrases like 9am, 9:30 PM, 21:00 */
export function parseClockTime(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '');
  const withMeridiem = cleaned.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (withMeridiem) {
    let hour = Number(withMeridiem[1]);
    const minute = withMeridiem[2] ? Number(withMeridiem[2]) : 0;
    const mer = withMeridiem[3];
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (mer === 'am') {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const twentyFour = cleaned.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (twentyFour) {
    return `${twentyFour[1].padStart(2, '0')}:${twentyFour[2]}`;
  }
  return null;
}

function uniqueSortedTimes(times: string[]): string[] {
  return Array.from(new Set(times)).sort();
}

function extractTimes(text: string): string[] {
  const times: string[] = [];
  const re = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = parseClockTime(m[1]);
    if (t) times.push(t);
  }
  return uniqueSortedTimes(times);
}

function extractWeekdays(text: string): number[] {
  const lower = text.toLowerCase();
  if (/\b(weekdays?|monday\s*[-–to]+\s*friday|mon\s*[-–to]+\s*fri)\b/.test(lower)) {
    return [1, 2, 3, 4, 5];
  }
  if (/\bevery\s+day|daily|each\s+day\b/.test(lower)) {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  if (/\bweekends?\b/.test(lower)) {
    return [0, 6];
  }
  const found = new Set<number>();
  for (const [token, day] of Object.entries(WEEKDAY_MAP)) {
    if (new RegExp(`\\b${token}\\b`, 'i').test(lower)) {
      found.add(day);
    }
  }
  return [...found].sort((a, b) => a - b);
}

function stripSchedulePreamble(description: string): string {
  let rest = description.trim();
  // Remove leading schedule boilerplate so the agent prompt is the action
  rest = rest.replace(
    /^(?:every\s+(?:weekday|day|week|morning|evening)|daily|on\s+(?:weekdays?|mon(?:day)?(?:\s*[-–to]+\s*fri(?:day)?)?)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|,\s*)+/gi,
    ''
  );
  rest = rest.replace(
    /\b(?:every\s+(?:weekday|day)|on\s+weekdays?|daily|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b[,:\s]*/gi,
    ' '
  );
  rest = rest.replace(/^(?:please\s+)?(?:automate|create a workflow(?: that)?|set up(?: a workflow)?(?: that)?|when)\s+/i, '');
  rest = rest.replace(/\s+/g, ' ').trim();
  return rest || description.trim();
}

function deriveName(description: string, action: string): string {
  const base = (action || description).trim().replace(/\s+/g, ' ');
  // Prefer "brief me on Hub leave" style — drop schedule words for name
  let name = base
    .replace(/^(me\s+on\s+|for\s+)/i, '')
    .slice(0, 60)
    .trim();
  if (!name) name = 'Proposed workflow';
  // Title-case lightly
  if (name === name.toLowerCase()) {
    name = name.charAt(0).toUpperCase() + name.slice(1);
  }
  return name;
}

function detectChannel(text: string): string | null {
  const lower = text.toLowerCase();
  if (/\bslack\b/.test(lower)) return 'slack';
  if (/\b(feishu|lark)\b/.test(lower)) return 'feishu';
  if (/\btelegram\b/.test(lower)) return 'telegram';
  if (/\b(email|gmail|inbox)\b/.test(lower)) return 'email';
  return null;
}

function wantsApproval(text: string): boolean {
  if (/\b(read.?only|no approval|without approval|just (?:read|brief|summarize))\b/i.test(text)) {
    return false;
  }
  // Side-effect verbs require approval
  if (
    /\b(send|post|email|mail|dm|delete|remove|create|write|update|publish|deploy|assign|invite|share|upload|submit|reply|approve|transition|slack message)\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (/\b(approve|confirmation|gated?|side effect)\b/i.test(text)) return true;
  // Default: no approval for briefing / status style automations
  return false;
}

function wantsNotify(text: string): boolean {
  return /\b(notify|ping|message me|tell me|dm me|alert me|send (?:me )?(?:a )?(?:slack|email|message)|when done)\b/i.test(
    text
  );
}

function splitActionSteps(action: string): string[] {
  const parts = action
    .split(/\s*(?:;\s*|\.\s+|\bthen\b|\band then\b)\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 3);
  if (parts.length <= 1) return [action.trim()].filter(Boolean);
  return parts.slice(0, 5);
}

/**
 * Author a workflow graph from free text — used by UI Propose and agent without graph.
 */
export function buildWorkflowFromDescription(description: string): WorkflowBuildResult {
  const raw = description.trim();
  if (raw.length < 3) {
    throw new WorkflowGraphValidationError('Description is too short.');
  }

  const warnings: string[] = [];
  const times = extractTimes(raw);
  const weekdays = extractWeekdays(raw);
  const channelHit = detectChannel(raw);
  const action = stripSchedulePreamble(raw);
  const name = deriveName(raw, action);
  const summary: string[] = [];

  let triggerKind: WorkflowTriggerKind = 'manual';
  let trigger: WorkflowTriggerNode = {
    id: 'trigger_1',
    type: 'trigger',
    label: 'Manual trigger',
    trigger: 'manual',
    x: 40,
    y: 80,
  };

  // Prefer schedule when times or weekday cadence appear
  if (times.length > 0 || weekdays.length > 0 || /\b(every day|daily|schedule|cron)\b/i.test(raw)) {
    triggerKind = 'cron';
    const cronTimes = times.length > 0 ? times : ['09:00'];
    if (times.length === 0) {
      warnings.push('No clock time found; defaulting schedule to 09:00.');
    }
    const cronWeekdays =
      weekdays.length > 0
        ? weekdays
        : /\bdaily|every day\b/i.test(raw)
          ? [0, 1, 2, 3, 4, 5, 6]
          : [1, 2, 3, 4, 5];
    trigger = {
      id: 'trigger_1',
      type: 'trigger',
      label:
        cronWeekdays.length === 7
          ? `Daily at ${cronTimes.join(', ')}`
          : cronWeekdays.length === 5 && cronWeekdays.join() === '1,2,3,4,5'
            ? `Weekdays at ${cronTimes.join(', ')}`
            : `Schedule at ${cronTimes.join(', ')}`,
      trigger: 'cron',
      cron: {
        times: cronTimes,
        weekdays: cronWeekdays,
      },
      x: 40,
      y: 80,
    };
    summary.push(`Trigger: cron (${trigger.label})`);
  } else if (
    /\bwhen\s+(?:a\s+)?(?:message|slack|email|dm)|on\s+(?:slack|email|channel)\b/i.test(raw) ||
    (channelHit && /\bwhen\b|\bon\b/.test(raw.toLowerCase()))
  ) {
    triggerKind = 'channel';
    trigger = {
      id: 'trigger_1',
      type: 'trigger',
      label: channelHit ? `${channelHit} event` : 'Channel event',
      trigger: 'channel',
      channel: channelHit || 'slack',
      x: 40,
      y: 80,
    };
    summary.push(`Trigger: channel (${trigger.channel})`);
  } else {
    summary.push('Trigger: manual');
  }

  void triggerKind;

  const steps = splitActionSteps(action);
  const nodes: WorkflowNode[] = [trigger];
  const edges: WorkflowEdge[] = [];
  let prevId = trigger.id;
  let x = 240;

  steps.forEach((step, i) => {
    const id = `agent_${i + 1}`;
    const prompt = craftAgentPrompt(step, raw);
    nodes.push({
      id,
      type: 'agent',
      label: labelForStep(step, i),
      prompt,
      x,
      y: 80,
    });
    edges.push({ id: `e_${prevId}_${id}`, from: prevId, to: id });
    prevId = id;
    x += 200;
    summary.push(`Agent: ${labelForStep(step, i)}`);
  });

  if (wantsApproval(raw)) {
    const id = 'approval_1';
    nodes.push({
      id,
      type: 'approval',
      label: 'Approve side effects',
      message: `Approve running automation “${name}”?`,
      requireApproval: true,
      x,
      y: 80,
    });
    edges.push({ id: `e_${prevId}_${id}`, from: prevId, to: id });
    prevId = id;
    x += 200;
    summary.push('Approval: required before later steps');
  } else {
    warnings.push('No approval gate (side-effect language not detected).');
  }

  // Notify only when explicitly requested (or a channel was named for messaging)
  if (wantsNotify(raw) || (channelHit && /\b(slack|email|notify|message)\b/i.test(raw))) {
    const id = 'notify_1';
    nodes.push({
      id,
      type: 'notify',
      label: 'Notify when done',
      message: `Workflow finished: ${name}`,
      channel: channelHit || undefined,
      x,
      y: 80,
    });
    edges.push({ id: `e_${prevId}_${id}`, from: prevId, to: id });
    summary.push(channelHit ? `Notify: ${channelHit}` : 'Notify: local completion signal');
  }

  const graph: WorkflowGraph = {
    version: WORKFLOW_SCHEMA_VERSION,
    nodes,
    edges,
  };

  validateWorkflowGraph(graph);

  return {
    input: {
      name,
      description: raw,
      status: 'draft',
      graph,
    },
    summary,
    warnings,
  };
}

function labelForStep(step: string, index: number): string {
  const short = step.replace(/\s+/g, ' ').slice(0, 36).trim();
  if (short.length < 4) return `Agent step ${index + 1}`;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function craftAgentPrompt(step: string, fullDescription: string): string {
  return [
    WORKFLOW_AGENT_STEP_MARKER,
    'You are executing one step of a durable York workflow.',
    'Follow the instruction carefully. Prefer connected company tools (Hub, Calendar, Slack, Gmail, meetings) over inventing data.',
    'Be concise. If something is blocked (auth, missing connector), report it clearly and stop that step.',
    'Do NOT call workflow_propose or invent new workflows — complete this step only.',
    '',
    'Instruction:',
    step,
    '',
    'Full automation context:',
    fullDescription,
  ].join('\n');
}

/**
 * Validate graph structure (subset of OpenHuman validate_and_migrate_graph).
 */
export function validateWorkflowGraph(graph: WorkflowGraph): void {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new WorkflowGraphValidationError('Graph must include nodes[] and edges[].');
  }
  if (graph.nodes.length === 0) {
    throw new WorkflowGraphValidationError('Graph has no nodes.');
  }

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node?.id || typeof node.id !== 'string') {
      throw new WorkflowGraphValidationError('Every node needs a string id.');
    }
    if (ids.has(node.id)) {
      throw new WorkflowGraphValidationError(`Duplicate node id: ${node.id}`);
    }
    ids.add(node.id);

    if (node.type === 'trigger') {
      // ok
    } else if (node.type === 'agent') {
      if (!node.prompt?.trim()) {
        throw new WorkflowGraphValidationError(`Agent node ${node.id} needs a prompt.`);
      }
    } else if (node.type === 'tool') {
      if (!node.toolName?.trim()) {
        throw new WorkflowGraphValidationError(`Tool node ${node.id} needs toolName.`);
      }
    } else if (node.type === 'approval') {
      if (!node.message?.trim()) {
        throw new WorkflowGraphValidationError(`Approval node ${node.id} needs a message.`);
      }
      if (node.requireApproval !== true) {
        throw new WorkflowGraphValidationError(
          `Approval node ${node.id} must set requireApproval: true.`
        );
      }
    } else if (node.type === 'notify') {
      if (!node.message?.trim()) {
        throw new WorkflowGraphValidationError(`Notify node ${node.id} needs a message.`);
      }
    } else {
      const unknown = node as WorkflowNode;
      throw new WorkflowGraphValidationError(
        `Unknown node type on ${unknown.id}: ${unknown.type}`
      );
    }
  }

  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) {
    throw new WorkflowGraphValidationError(
      `Exactly one trigger node is required (found ${triggers.length}).`
    );
  }

  for (const edge of graph.edges) {
    if (!edge?.id || !edge.from || !edge.to) {
      throw new WorkflowGraphValidationError('Edges need id, from, and to.');
    }
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new WorkflowGraphValidationError(
        `Edge ${edge.id} references missing node (${edge.from} → ${edge.to}).`
      );
    }
  }

  const cron = triggers[0] as WorkflowTriggerNode;
  if (cron.trigger === 'cron') {
    const times = cron.cron?.times || [];
    if (times.length === 0) {
      throw new WorkflowGraphValidationError('Cron trigger needs at least one HH:MM time.');
    }
    for (const t of times) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        throw new WorkflowGraphValidationError(`Invalid cron time: ${t}`);
      }
    }
  }
  if (cron.trigger === 'channel' && !cron.channel?.trim()) {
    throw new WorkflowGraphValidationError('Channel trigger needs a channel name.');
  }
}

/**
 * Accept agent-supplied graph (OpenHuman propose_workflow style).
 */
export function buildWorkflowFromGraphInput(input: {
  name: string;
  description?: string;
  graph: WorkflowGraph;
  requireApproval?: boolean;
}): WorkflowBuildResult {
  const name = input.name.trim();
  if (!name) throw new WorkflowGraphValidationError('Missing workflow name.');

  // Clone and normalize
  const nodes: WorkflowNode[] = input.graph.nodes.map((n) => {
    if (n.type === 'approval') {
      return { ...n, requireApproval: true as const };
    }
    return { ...n };
  });
  const edges = [...input.graph.edges];

  // Optionally inject approval if missing and required
  if (input.requireApproval !== false) {
    const hasApproval = nodes.some((n) => n.type === 'approval');
    if (!hasApproval) {
      const leaves = nodes
        .filter((n) => n.type !== 'trigger')
        .filter((n) => !edges.some((e) => e.from === n.id));
      const attachTo =
        leaves[leaves.length - 1]?.id ||
        nodes.filter((n) => n.type !== 'trigger').slice(-1)[0]?.id ||
        nodes[0].id;
      const approvalId = 'approval_auto';
      nodes.push({
        id: approvalId,
        type: 'approval',
        label: 'Approve side effects',
        message: `Approve running automation “${name}”?`,
        requireApproval: true,
        x: 500,
        y: 80,
      });
      // Wire: attachTo → approval; retarget edges that left attachTo if any
      edges.push({ id: `e_${attachTo}_${approvalId}`, from: attachTo, to: approvalId });
    }
  }

  const graph: WorkflowGraph = {
    version: WORKFLOW_SCHEMA_VERSION,
    nodes,
    edges,
  };
  validateWorkflowGraph(graph);

  const summary = graph.nodes.map((n) => {
    if (n.type === 'trigger') return `Trigger: ${n.trigger}${n.cron?.times ? ` @ ${n.cron.times.join(',')}` : ''}`;
    if (n.type === 'agent') return `Agent: ${n.label}`;
    if (n.type === 'tool') return `Tool: ${n.toolName}`;
    if (n.type === 'approval') return 'Approval: gate';
    if (n.type === 'notify') return `Notify: ${n.channel || 'local'}`;
    return (n as WorkflowNode).id;
  });

  return {
    input: {
      name,
      description: input.description?.trim() || name,
      status: 'draft',
      graph,
    },
    summary,
    warnings: [],
  };
}

export function getCronTriggerConfig(graph: WorkflowGraph): {
  times: string[];
  weekdays: number[];
} | null {
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger || trigger.type !== 'trigger' || trigger.trigger !== 'cron') return null;
  const times = trigger.cron?.times || [];
  const weekdays = trigger.cron?.weekdays || [1, 2, 3, 4, 5];
  if (!times.length) return null;
  return { times, weekdays };
}
