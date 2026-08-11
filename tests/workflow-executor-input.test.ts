import { describe, expect, it, vi } from 'vitest';
import type { CheckpointPayload, CheckpointRun, CheckpointRunStatus } from '../src/shared/orchestration';
import type { WorkflowDefinition } from '../src/shared/workflows';
import { WORKFLOW_SCHEMA_VERSION } from '../src/shared/workflows';
import {
  WorkflowExecutor,
  type WorkflowExecutorApi,
} from '../src/main/workflows/workflow-executor';
import type { CheckpointService } from '../src/main/orchestration/checkpoint-service';

function createMemoryCheckpoints(): CheckpointService {
  const runs = new Map<string, CheckpointRun>();
  let seq = 0;

  const service = {
    startRun(input: {
      kind: CheckpointRun['kind'];
      stepId?: string;
      payload?: CheckpointPayload;
      sessionId?: string | null;
      sourceId?: string | null;
      title?: string | null;
    }): CheckpointRun {
      seq += 1;
      const now = Date.now();
      const run: CheckpointRun = {
        id: `run_${seq}`,
        kind: input.kind,
        stepId: input.stepId || 'start',
        status: 'running',
        payload: { ...(input.payload || {}) },
        error: null,
        costUsd: null,
        sessionId: input.sessionId ?? null,
        sourceId: input.sourceId ?? null,
        title: input.title ?? null,
        stuckSummary: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      runs.set(run.id, run);
      return { ...run, payload: { ...run.payload } };
    },
    checkpoint(
      id: string,
      stepId: string,
      payload?: CheckpointPayload,
      status?: CheckpointRunStatus
    ): CheckpointRun | null {
      const run = runs.get(id);
      if (!run) return null;
      run.stepId = stepId;
      run.payload = { ...run.payload, ...(payload || {}) };
      if (status) run.status = status;
      run.updatedAt = Date.now();
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        run.completedAt = Date.now();
      }
      return { ...run, payload: { ...run.payload } };
    },
    fail(id: string, error: string): CheckpointRun | null {
      const run = runs.get(id);
      if (!run) return null;
      run.status = 'failed';
      run.error = error;
      run.updatedAt = Date.now();
      run.completedAt = Date.now();
      return { ...run, payload: { ...run.payload } };
    },
    resume(id: string): CheckpointRun | null {
      const run = runs.get(id);
      if (!run) return null;
      run.status = 'running';
      run.updatedAt = Date.now();
      return { ...run, payload: { ...run.payload } };
    },
    get(id: string): CheckpointRun | null {
      const run = runs.get(id);
      return run ? { ...run, payload: { ...run.payload } } : null;
    },
  };

  return service as unknown as CheckpointService;
}

function definition(): WorkflowDefinition {
  return {
    id: 'wf_input',
    name: 'Input handoff',
    description: 'test',
    status: 'enabled',
    graph: {
      version: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        { id: 'trigger_1', type: 'trigger', label: 'Manual', trigger: 'manual' },
        {
          id: 'input_1',
          type: 'input',
          label: 'Collect',
          prompt: 'What project should we use?',
          fields: [
            { key: 'project', label: 'Project', kind: 'text', required: true },
          ],
        },
        {
          id: 'agent_1',
          type: 'agent',
          label: 'Act',
          prompt: 'Use the collected project name.',
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger_1', to: 'input_1' },
        { id: 'e2', from: 'input_1', to: 'agent_1' },
      ],
    },
    scheduleTaskId: null,
    division: 'general',
    hubProjectId: null,
    hubProjectName: null,
    launchpadProjectId: null,
    launchpadProjectName: null,
    folderId: null,
    folderName: null,
    canonicalKey: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('WorkflowExecutor input steps', () => {
  it('pauses for input, stores answers, and hands them to later agent prompts', async () => {
    const checkpoints = createMemoryCheckpoints();
    const runAgentStep = vi.fn(async ({ prompt }: { prompt: string }) => ({
      sessionId: 'sess_1',
      summary: `Done with prompt containing ${prompt.includes('Acme Corp') ? 'project' : 'missing'}`,
    }));

    const api: WorkflowExecutorApi = {
      runAgentStep,
      requestApproval: async () => 'allow',
      requestUserInput: async () => ({
        kind: 'submitted',
        answers: { project: 'Acme Corp' },
      }),
    };

    const executor = new WorkflowExecutor(checkpoints, api);
    const result = await executor.startWorkflow(definition());
    expect(result.status).toBe('completed');
    expect(runAgentStep).toHaveBeenCalledTimes(1);
    const prompt = runAgentStep.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Use the collected project name.');
    expect(prompt).toContain('Prior step results');
    expect(prompt).toContain('Project: Acme Corp');

    const run = checkpoints.get(result.runId);
    const steps = Array.isArray(run?.payload.steps) ? run!.payload.steps : [];
    const inputStep = steps.find(
      (s: { nodeId?: string }) => s.nodeId === 'input_1'
    ) as { status?: string; output?: { answers?: Record<string, string> } };
    expect(inputStep?.status).toBe('success');
    expect(inputStep?.output?.answers?.project).toBe('Acme Corp');
  });

  it('fails the run when input is cancelled', async () => {
    const checkpoints = createMemoryCheckpoints();
    const api: WorkflowExecutorApi = {
      runAgentStep: async () => ({ sessionId: null, summary: null }),
      requestApproval: async () => 'allow',
      requestUserInput: async () => ({ kind: 'cancelled' }),
    };
    const executor = new WorkflowExecutor(checkpoints, api);
    const result = await executor.startWorkflow(definition());
    expect(result.status).toBe('failed');
    const run = checkpoints.get(result.runId);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/Input cancelled/i);
  });
});
