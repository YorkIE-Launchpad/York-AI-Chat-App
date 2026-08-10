import { describe, expect, it } from 'vitest';
import {
  autoLayoutLinear,
  ensureGraphPositions,
  flowToWorkflowGraph,
  graphNeedsAutoLayout,
  workflowGraphToFlow,
} from '../src/shared/workflow-graph-xyflow';
import {
  WORKFLOW_SCHEMA_VERSION,
  hasGraphCycle,
  wouldCreateCycle,
  type WorkflowGraph,
} from '../src/shared/workflows';
import {
  addNode,
  connectNodes,
  disconnectEdge,
  removeNode,
  setNodePosition,
} from '../src/shared/workflow-graph-edit';
import { validateWorkflowGraph, WorkflowGraphValidationError } from '../src/main/workflows/workflow-build';

function linearGraph(): WorkflowGraph {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    nodes: [
      { id: 'trigger_1', type: 'trigger', label: 'Manual', trigger: 'manual', x: 40, y: 80 },
      { id: 'agent_1', type: 'agent', label: 'First', prompt: 'Do A', x: 260, y: 80 },
      { id: 'agent_2', type: 'agent', label: 'Second', prompt: 'Do B', x: 480, y: 80 },
    ],
    edges: [
      { id: 'e_t_1', from: 'trigger_1', to: 'agent_1' },
      { id: 'e_1_2', from: 'agent_1', to: 'agent_2' },
    ],
  };
}

describe('workflow-graph-xyflow adapter', () => {
  it('round-trips graph through flow DTO preserving ids edges types positions', () => {
    const graph = linearGraph();
    const flow = workflowGraphToFlow(graph, { selectedNodeId: 'agent_1' });
    expect(flow.nodes).toHaveLength(3);
    expect(flow.edges).toHaveLength(2);
    expect(flow.nodes.find((n) => n.id === 'agent_1')?.selected).toBe(true);
    expect(flow.nodes.find((n) => n.id === 'agent_1')?.data.nodeType).toBe('agent');

    const back = flowToWorkflowGraph(flow.nodes, flow.edges, graph);
    expect(back.nodes.map((n) => n.id).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
    expect(back.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(
      graph.edges.map((e) => `${e.from}->${e.to}`).sort()
    );
    const agent = back.nodes.find((n) => n.id === 'agent_1');
    expect(agent?.type === 'agent' && agent.prompt).toBe('Do A');
    expect(agent?.x).toBe(260);
    expect(agent?.y).toBe(80);
  });

  it('autoLayout fills missing coordinates', () => {
    const graph: WorkflowGraph = {
      version: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        { id: 'trigger_1', type: 'trigger', label: 'Manual', trigger: 'manual' },
        { id: 'agent_1', type: 'agent', label: 'A', prompt: 'A' },
      ],
      edges: [{ id: 'e1', from: 'trigger_1', to: 'agent_1' }],
    };
    expect(graphNeedsAutoLayout(graph)).toBe(true);
    const laid = autoLayoutLinear(graph);
    expect(laid.nodes.every((n) => n.x != null && n.y != null)).toBe(true);
    expect(ensureGraphPositions(laid)).toBe(laid); // already positioned
    expect(graphNeedsAutoLayout(laid)).toBe(false);
  });

  it('attaches run status into flow node data', () => {
    const flow = workflowGraphToFlow(linearGraph(), {
      stepStatusByNodeId: { agent_1: 'running', agent_2: 'pending' },
    });
    expect(flow.nodes.find((n) => n.id === 'agent_1')?.data.runStatus).toBe('running');
    expect(flow.nodes.find((n) => n.id === 'agent_2')?.data.runStatus).toBe('pending');
  });
});

describe('workflow graph freeform edits', () => {
  it('adds agent connected from selection and sets position', () => {
    const next = addNode(linearGraph(), 'agent', {
      connectFromId: 'agent_2',
      position: { x: 700, y: 90 },
      label: 'Third',
      prompt: 'Do C',
    });
    const added = next.nodes.find((n) => n.label === 'Third')!;
    expect(added.type).toBe('agent');
    expect(added.x).toBe(700);
    expect(next.edges.some((e) => e.from === 'agent_2' && e.to === added.id)).toBe(true);
  });

  it('connect rejects cycles and self loops', () => {
    expect(() => connectNodes(linearGraph(), 'agent_2', 'agent_1')).toThrow(/cycle/i);
    expect(() => connectNodes(linearGraph(), 'agent_1', 'agent_1')).toThrow(/itself/i);
    expect(wouldCreateCycle(linearGraph(), 'agent_2', 'agent_1')).toBe(true);
    expect(wouldCreateCycle(linearGraph(), 'agent_1', 'agent_2')).toBe(false); // already edge
  });

  it('disconnectEdge and removeNode reconnect chain', () => {
    let g = linearGraph();
    g = disconnectEdge(g, 'e_1_2');
    expect(g.edges.some((e) => e.from === 'agent_1' && e.to === 'agent_2')).toBe(false);
    g = connectNodes(g, 'agent_1', 'agent_2');
    g = removeNode(g, 'agent_1');
    expect(g.nodes.find((n) => n.id === 'agent_1')).toBeUndefined();
    expect(g.edges.some((e) => e.from === 'trigger_1' && e.to === 'agent_2')).toBe(true);
  });

  it('setNodePosition updates coordinates', () => {
    const next = setNodePosition(linearGraph(), 'agent_1', 12, 34);
    const n = next.nodes.find((x) => x.id === 'agent_1');
    expect(n?.x).toBe(12);
    expect(n?.y).toBe(34);
  });

  it('refuses removing trigger', () => {
    expect(() => removeNode(linearGraph(), 'trigger_1')).toThrow(/trigger/i);
  });
});

describe('validateWorkflowGraph cycles', () => {
  it('rejects cyclic graphs', () => {
    const cycle: WorkflowGraph = {
      version: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        { id: 'trigger_1', type: 'trigger', label: 'Manual', trigger: 'manual' },
        { id: 'agent_1', type: 'agent', label: 'A', prompt: 'A' },
        { id: 'agent_2', type: 'agent', label: 'B', prompt: 'B' },
      ],
      edges: [
        { id: 'e1', from: 'trigger_1', to: 'agent_1' },
        { id: 'e2', from: 'agent_1', to: 'agent_2' },
        { id: 'e3', from: 'agent_2', to: 'agent_1' },
      ],
    };
    expect(hasGraphCycle(cycle)).toBe(true);
    expect(() => validateWorkflowGraph(cycle)).toThrow(WorkflowGraphValidationError);
    expect(() => validateWorkflowGraph(cycle)).toThrow(/cycle/i);
  });

  it('accepts acyclic linear graphs', () => {
    expect(() => validateWorkflowGraph(linearGraph())).not.toThrow();
  });
});
