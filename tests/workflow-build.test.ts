import { describe, expect, it } from 'vitest';
import {
  buildWorkflowFromDescription,
  buildWorkflowFromGraphInput,
  parseClockTime,
  validateWorkflowGraph,
  WorkflowGraphValidationError,
} from '../src/main/workflows/workflow-build';
import {
  WORKFLOW_SCHEMA_VERSION,
  buildWorkflowTitle,
  formatWorkflowSchedulePrompt,
  formatWorkflowSessionTitle,
  isWorkflowAgentExecutionContext,
  normalizeWorkflowBinding,
  parseWorkflowSchedulePrompt,
  workflowBindingToStartOptions,
  workflowWorkspaceLabel,
} from '../src/shared/workflows';

describe('workflow-build (OpenHuman-style authoring)', () => {
  it('parses 12h and 24h clock times', () => {
    expect(parseClockTime('9am')).toBe('09:00');
    expect(parseClockTime('9:30 PM')).toBe('21:30');
    expect(parseClockTime('14:05')).toBe('14:05');
    expect(parseClockTime('not-a-time')).toBeNull();
  });

  it('builds cron trigger + multi-agent without default approval/notify for briefs', () => {
    const result = buildWorkflowFromDescription(
      'Every weekday at 9am, brief me on Hub leave balance and then summarize calendar'
    );
    expect(result.input.status).toBe('draft');
    expect(result.input.name.length).toBeLessThanOrEqual(60);
    expect(result.input.name).not.toMatch(/^Every weekday/i);

    const types = result.input.graph.nodes.map((n) => n.type);
    expect(types[0]).toBe('trigger');
    expect(types).toContain('agent');
    expect(types).not.toContain('approval');
    expect(types).not.toContain('notify');

    const trigger = result.input.graph.nodes.find((n) => n.type === 'trigger');
    expect(trigger && trigger.type === 'trigger' && trigger.trigger).toBe('cron');
    if (trigger && trigger.type === 'trigger' && trigger.cron) {
      expect(trigger.cron.times).toEqual(['09:00']);
      expect(trigger.cron.weekdays).toEqual([1, 2, 3, 4, 5]);
    }

    expect(result.input.graph.nodes.filter((n) => n.type === 'agent').length).toBeGreaterThanOrEqual(
      2
    );
  });

  it('adds approval for side effects and notify when requested', () => {
    const result = buildWorkflowFromDescription(
      'Every day at 9am, update Hub allocations then send a Slack message when done'
    );
    const types = result.input.graph.nodes.map((n) => n.type);
    expect(types).toContain('approval');
    expect(types).toContain('notify');
  });

  it('adds input step when description asks to collect user input', () => {
    const result = buildWorkflowFromDescription(
      'Ask the user for a project name then brief me on Hub leave'
    );
    const types = result.input.graph.nodes.map((n) => n.type);
    expect(types).toContain('input');
    const input = result.input.graph.nodes.find((n) => n.type === 'input');
    expect(input?.type === 'input' && input.fields.length).toBeGreaterThan(0);
  });

  it('validates input nodes require prompt and fields', () => {
    expect(() =>
      validateWorkflowGraph({
        version: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          { id: 't', type: 'trigger', label: 'T', trigger: 'manual' },
          {
            id: 'i',
            type: 'input',
            label: 'Input',
            prompt: '',
            fields: [{ key: 'a', label: 'A', kind: 'text' }],
          },
        ],
        edges: [{ id: 'e1', from: 't', to: 'i' }],
      })
    ).toThrow(/prompt/i);

    expect(() =>
      validateWorkflowGraph({
        version: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          { id: 't', type: 'trigger', label: 'T', trigger: 'manual' },
          {
            id: 'i',
            type: 'input',
            label: 'Input',
            prompt: 'Need info',
            fields: [{ key: 'choice', label: 'Choice', kind: 'choice', options: ['Only one'] }],
          },
        ],
        edges: [{ id: 'e1', from: 't', to: 'i' }],
      })
    ).toThrow(/at least 2 options/i);
  });

  it('detects channel triggers', () => {
    const result = buildWorkflowFromDescription(
      'When a Slack message mentions urgent, draft a reply for approval'
    );
    const trigger = result.input.graph.nodes.find((n) => n.type === 'trigger');
    expect(trigger && trigger.type === 'trigger' && trigger.trigger).toBe('channel');
    if (trigger && trigger.type === 'trigger') {
      expect(trigger.channel).toBe('slack');
    }
  });

  it('validates agent prompts and single trigger', () => {
    expect(() =>
      validateWorkflowGraph({
        version: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          { id: 't', type: 'trigger', label: 'T', trigger: 'manual' },
          { id: 'a', type: 'agent', label: 'A', prompt: '' },
        ],
        edges: [{ id: 'e1', from: 't', to: 'a' }],
      })
    ).toThrow(WorkflowGraphValidationError);

    expect(() =>
      validateWorkflowGraph({
        version: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          { id: 't1', type: 'trigger', label: 'T1', trigger: 'manual' },
          { id: 't2', type: 'trigger', label: 'T2', trigger: 'manual' },
        ],
        edges: [],
      })
    ).toThrow(/Exactly one trigger/);
  });

  it('accepts agent-supplied graphs and injects approval when required', () => {
    const result = buildWorkflowFromGraphInput({
      name: 'Hub leave brief',
      description: 'test',
      requireApproval: true,
      graph: {
        version: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: 'trigger_1',
            type: 'trigger',
            label: 'Manual',
            trigger: 'manual',
          },
          {
            id: 'agent_1',
            type: 'agent',
            label: 'Brief',
            prompt: 'Summarize leave balances',
          },
        ],
        edges: [{ id: 'e1', from: 'trigger_1', to: 'agent_1' }],
      },
    });
    expect(result.input.status).toBe('draft');
    expect(result.input.graph.nodes.some((n) => n.type === 'approval')).toBe(true);
  });

  it('round-trips schedule prompt markers', () => {
    const prompt = formatWorkflowSchedulePrompt('wf_123', 'Daily brief');
    expect(parseWorkflowSchedulePrompt(prompt)).toBe('wf_123');
    expect(parseWorkflowSchedulePrompt('normal prompt')).toBeNull();
  });

  it('detects workflow agent execution context (no authoring tools)', () => {
    expect(
      isWorkflowAgentExecutionContext({
        title: 'Workflow run · abcd1234',
        prompt: 'hi',
      })
    ).toBe(true);
    expect(
      isWorkflowAgentExecutionContext({
        title: formatWorkflowSessionTitle('Daily leave brief', 'Agent step'),
        prompt: 'hi',
      })
    ).toBe(true);
    expect(
      isWorkflowAgentExecutionContext({
        title: 'Chat',
        prompt: '[[YORK_WORKFLOW_AGENT_STEP]]\nDo the thing',
      })
    ).toBe(true);
    expect(
      isWorkflowAgentExecutionContext({
        title: 'Morning plan',
        prompt: 'Help me plan today',
      })
    ).toBe(false);
  });
});

describe('workflow title + workspace binding', () => {
  it('normalizes titles', () => {
    expect(buildWorkflowTitle('  Workflow:  daily brief  ')).toBe('daily brief');
    expect(buildWorkflowTitle('x'.repeat(80)).length).toBeLessThanOrEqual(60);
    expect(buildWorkflowTitle('')).toBe('Untitled workflow');
  });

  it('formats run session titles with workflow name', () => {
    const title = formatWorkflowSessionTitle('Leave brief', 'Hub pull');
    expect(title.startsWith('Workflow run · ')).toBe(true);
    expect(title).toContain('Leave brief');
    expect(title).toContain('Hub pull');
  });

  it('normalizes project binding and start options', () => {
    const binding = normalizeWorkflowBinding({
      division: 'project',
      hubProjectId: 'hub-1',
      hubProjectName: 'Acme',
    });
    expect(binding.division).toBe('project');
    expect(binding.canonicalKey).toBeTruthy();
    expect(workflowWorkspaceLabel(binding as never)).toContain('Acme');

    const opts = workflowBindingToStartOptions({
      division: 'project',
      hubProjectId: 'hub-1',
      hubProjectName: 'Acme',
      launchpadProjectId: null,
      launchpadProjectName: null,
      folderId: null,
      folderName: null,
      canonicalKey: binding.canonicalKey ?? null,
    });
    expect(opts.division).toBe('project');
    expect(opts.hubProjectId).toBe('hub-1');

    expect(normalizeWorkflowBinding({ division: 'project' }).division).toBe('general');
    expect(normalizeWorkflowBinding(null).division).toBe('general');
  });
});
