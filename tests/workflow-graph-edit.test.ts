import { describe, expect, it } from 'vitest';
import {
  composeAgentStepPrompt,
  extractPriorAgentResults,
  insertAgentAfter,
  removeAgentNode,
  sessionIdsFromWorkflowRun,
  updateNodeFields,
  addNode,
} from '../src/shared/workflow-graph-edit';
import { WORKFLOW_SCHEMA_VERSION, buildInitialRunSteps, type WorkflowGraph } from '../src/shared/workflows';

function linearGraph(): WorkflowGraph {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    nodes: [
      { id: 'trigger_1', type: 'trigger', label: 'Manual', trigger: 'manual' },
      { id: 'agent_1', type: 'agent', label: 'First', prompt: 'Do A' },
      { id: 'agent_2', type: 'agent', label: 'Second', prompt: 'Do B' },
    ],
    edges: [
      { id: 'e_t_1', from: 'trigger_1', to: 'agent_1' },
      { id: 'e_1_2', from: 'agent_1', to: 'agent_2' },
    ],
  };
}

describe('workflow-graph-edit', () => {
  it('inserts agent between nodes and rewires edges', () => {
    const next = insertAgentAfter(linearGraph(), 'agent_1', {
      label: 'Middle',
      prompt: 'Do mid',
    });
    expect(next.nodes.some((n) => n.label === 'Middle')).toBe(true);
    const inserted = next.nodes.find((n) => n.label === 'Middle')!;
    expect(next.edges.some((e) => e.from === 'agent_1' && e.to === inserted.id)).toBe(true);
    expect(next.edges.some((e) => e.from === inserted.id && e.to === 'agent_2')).toBe(true);
    expect(next.edges.some((e) => e.from === 'agent_1' && e.to === 'agent_2')).toBe(false);
    // nodes[] and run steps must place Middle before Second (not at end)
    expect(next.nodes.map((n) => n.id)).toEqual([
      'trigger_1',
      'agent_1',
      inserted.id,
      'agent_2',
    ]);
  });

  it('removes agent and reconnects linear chain', () => {
    const next = removeAgentNode(linearGraph(), 'agent_1');
    expect(next.nodes.find((n) => n.id === 'agent_1')).toBeUndefined();
    expect(next.edges.some((e) => e.from === 'trigger_1' && e.to === 'agent_2')).toBe(true);
  });

  it('refuses removing last agent', () => {
    const graph: WorkflowGraph = {
      version: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        { id: 'trigger_1', type: 'trigger', label: 'Manual', trigger: 'manual' },
        { id: 'agent_1', type: 'agent', label: 'Only', prompt: 'Do A' },
      ],
      edges: [{ id: 'e', from: 'trigger_1', to: 'agent_1' }],
    };
    expect(() => removeAgentNode(graph, 'agent_1')).toThrow(/only agent/i);
  });

  it('updates agent prompt and model', () => {
    const next = updateNodeFields(linearGraph(), 'agent_1', {
      prompt: 'New instructions',
      model: 'openrouter/free',
      provider: 'openrouter',
    });
    const agent = next.nodes.find((n) => n.id === 'agent_1');
    expect(agent?.type === 'agent' && agent.prompt).toBe('New instructions');
    expect(agent?.type === 'agent' && agent.model).toBe('openrouter/free');
    expect(agent?.type === 'agent' && agent.provider).toBe('openrouter');

    const cleared = updateNodeFields(next, 'agent_1', { model: null, provider: null });
    const agent2 = cleared.nodes.find((n) => n.id === 'agent_1');
    expect(agent2?.type === 'agent' && agent2.model).toBeUndefined();
  });

  it('composes prior results only for subsequent agents', () => {
    const first = composeAgentStepPrompt('First prompt', []);
    expect(first).toBe('First prompt');
    expect(first).not.toContain('Prior step results');

    const second = composeAgentStepPrompt('Second prompt', [
      { label: 'First', summary: 'Leave balance is fine.' },
    ]);
    expect(second).toContain('Second prompt');
    expect(second).toContain('Prior step results');
    expect(second).toContain('Leave balance is fine.');
  });

  it('extracts prior agent success summaries', () => {
    const prior = extractPriorAgentResults([
      {
        nodeId: 'agent_1',
        type: 'agent',
        label: 'Research',
        status: 'success',
        summary: 'Found two blockers.',
      },
      {
        nodeId: 'agent_2',
        type: 'agent',
        label: 'Write',
        status: 'running',
        summary: 'Working…',
      },
    ]);
    expect(prior).toEqual([{ label: 'Research', summary: 'Found two blockers.' }]);
  });

  it('collects session ids from run payload and step outputs', () => {
    const ids = sessionIdsFromWorkflowRun({
      sessionId: 'sess-final',
      steps: [
        { nodeId: 'a1', output: { sessionId: 'sess-1' } },
        { nodeId: 'a2', output: { sessionId: 'sess-2' } },
      ],
    });
    expect(ids).toEqual(['sess-final', 'sess-1', 'sess-2']);
  });

  it('buildInitialRunSteps follows edge order even if node is last in array', () => {
    const graph: WorkflowGraph = {
      version: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        { id: 'trigger_1', type: 'trigger', label: 'Manual', trigger: 'manual' },
        { id: 'agent_1', type: 'agent', label: 'First', prompt: 'A' },
        { id: 'agent_2', type: 'agent', label: 'Second', prompt: 'B' },
        { id: 'agent_3', type: 'agent', label: 'Middle', prompt: 'M' }, // array-last, mid-pipeline
      ],
      edges: [
        { id: 'e1', from: 'trigger_1', to: 'agent_1' },
        { id: 'e2', from: 'agent_1', to: 'agent_3' },
        { id: 'e3', from: 'agent_3', to: 'agent_2' },
      ],
    };
    const steps = buildInitialRunSteps(graph);
    expect(steps.map((s) => s.nodeId)).toEqual([
      'trigger_1',
      'agent_1',
      'agent_3',
      'agent_2',
    ]);
  });

  it('adds and connects approval without cycle', () => {
    const g = addNode(linearGraph(), 'approval', {
      connectFromId: 'agent_2',
      message: 'OK?',
    });
    const approval = g.nodes.find((n) => n.type === 'approval');
    expect(approval).toBeTruthy();
    expect(g.edges.some((e) => e.to === approval!.id)).toBe(true);
  });
});
