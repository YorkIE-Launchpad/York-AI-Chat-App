/**
 * Workflow executor — runs graph nodes on the checkpoint engine,
 * writing a durable steps[] timeline into the run payload.
 */
import type { CheckpointService } from '../orchestration/checkpoint-service';
import type {
  WorkflowDefinition,
  WorkflowInputField,
  WorkflowNode,
  WorkflowRunProgressEvent,
  WorkflowRunStep,
} from '../../shared/workflows';
import {
  buildInitialRunSteps,
  getWorkflowRunSteps,
  topologicalOrder,
} from '../../shared/workflows';
import {
  composeAgentStepPrompt,
  extractPriorAgentResults,
  formatInputAnswersSummary,
} from '../../shared/workflow-graph-edit';
import type { CheckpointRun } from '../../shared/orchestration';
import { log, logWarn } from '../utils/logger';

export type WorkflowUserInputResult =
  | { kind: 'submitted'; answers: Record<string, string> }
  | { kind: 'cancelled' };

export interface WorkflowExecutorApi {
  /**
   * Run an agent prompt; wait until the session turn finishes.
   * Return session id + optional assistant summary for handoff.
   */
  runAgentStep: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    prompt: string;
    model?: string;
    provider?: string;
    stepLabel?: string;
  }) => Promise<{ sessionId?: string | null; summary?: string | null }>;
  requestApproval: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    message: string;
  }) => Promise<'allow' | 'deny'>;
  requestUserInput: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    prompt: string;
    fields: WorkflowInputField[];
    label?: string;
  }) => Promise<WorkflowUserInputResult>;
  notify?: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    message: string;
    channel?: string;
  }) => Promise<void>;
  onProgress?: (event: WorkflowRunProgressEvent) => void;
}

function truncateOutput(value: unknown, max = 4000): unknown {
  if (value == null) return value;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.length <= max) return value;
    return `${text.slice(0, max)}…`;
  } catch {
    return String(value);
  }
}

function updateStep(
  steps: WorkflowRunStep[],
  nodeId: string,
  patch: Partial<WorkflowRunStep>
): WorkflowRunStep[] {
  return steps.map((s) => (s.nodeId === nodeId ? { ...s, ...patch } : s));
}

function readSteps(
  checkpoints: CheckpointService,
  runId: string,
  fallback: WorkflowRunStep[]
): WorkflowRunStep[] {
  const loaded = getWorkflowRunSteps(checkpoints.get(runId)?.payload || {});
  return loaded.length > 0 ? loaded : fallback;
}

export class WorkflowExecutor {
  constructor(
    private readonly checkpoints: CheckpointService,
    private readonly api: WorkflowExecutorApi
  ) {}

  private emitProgress(run: CheckpointRun | null | undefined): void {
    if (!run || !this.api.onProgress) return;
    const workflowId = String(run.sourceId || run.payload.workflowId || '');
    this.api.onProgress({
      runId: run.id,
      workflowId,
      status: run.status,
      stepId: run.stepId,
      steps: getWorkflowRunSteps(run.payload),
    });
  }

  private persistSteps(
    runId: string,
    stepId: string,
    steps: WorkflowRunStep[],
    extra?: Record<string, unknown>,
    status?: CheckpointRun['status']
  ): CheckpointRun | null {
    const run = this.checkpoints.checkpoint(runId, stepId, { steps, ...extra }, status);
    this.emitProgress(run);
    return run;
  }

  async startWorkflow(
    workflow: WorkflowDefinition,
    options?: { resumeRunId?: string; fromStepId?: string }
  ): Promise<{ runId: string; status: string }> {
    let steps = buildInitialRunSteps(workflow.graph);

    const run =
      options?.resumeRunId != null
        ? (() => {
            const existing = this.checkpoints.get(options.resumeRunId!);
            if (existing) {
              const prior = getWorkflowRunSteps(existing.payload);
              if (prior.length > 0) steps = prior;
            }
            return this.checkpoints.resume(options.resumeRunId!);
          })()
        : this.checkpoints.startRun({
            kind: 'workflow',
            stepId: 'trigger',
            sourceId: workflow.id,
            title: workflow.name,
            payload: {
              workflowId: workflow.id,
              nodeResults: {},
              steps,
            },
          });

    if (!run) {
      throw new Error('Failed to start workflow run');
    }

    if (getWorkflowRunSteps(run.payload).length === 0) {
      this.persistSteps(run.id, run.stepId, steps, { workflowId: workflow.id });
    } else {
      this.emitProgress(run);
    }

    const order = topologicalOrder(workflow.graph);
    let startIndex = 0;
    if (options?.fromStepId) {
      const idx = order.findIndex((id) => id === options.fromStepId);
      startIndex = idx >= 0 ? idx : 0;
    }

    for (let i = startIndex; i < order.length; i += 1) {
      const nodeId = order[i];
      const node = workflow.graph.nodes.find((n) => n.id === nodeId);
      if (!node) continue;

      steps = readSteps(this.checkpoints, run.id, steps);
      if (steps.length === 0) {
        steps = buildInitialRunSteps(workflow.graph);
      }

      const existingStep = steps.find((s) => s.nodeId === nodeId);
      if (
        options?.resumeRunId &&
        existingStep &&
        (existingStep.status === 'success' || existingStep.status === 'skipped') &&
        nodeId !== options.fromStepId
      ) {
        continue;
      }

      if (node.type === 'trigger') {
        steps = updateStep(steps, node.id, {
          status: 'skipped',
          summary: 'Trigger fired',
          finishedAt: Date.now(),
        });
        this.persistSteps(run.id, node.id, steps, { lastNode: node.id });
        continue;
      }

      const now = Date.now();
      const isApproval = node.type === 'approval';
      const isInput = node.type === 'input';
      steps = updateStep(steps, node.id, {
        status: isApproval
          ? 'awaiting_approval'
          : isInput
            ? 'awaiting_input'
            : 'running',
        startedAt: existingStep?.startedAt ?? now,
        summary: isApproval
          ? node.message || 'Waiting for approval'
          : isInput
            ? node.prompt || 'Waiting for your input'
            : `Running ${node.label || node.type}…`,
      });
      this.persistSteps(run.id, node.id, steps, { lastNode: node.id });

      try {
        const result = await this.executeNode(workflow, run.id, node);
        steps = readSteps(this.checkpoints, run.id, steps);

        if (result === 'paused') {
          const msg =
            node.type === 'approval'
              ? node.message || 'Waiting for your approval'
              : node.type === 'input'
                ? node.prompt || 'Waiting for your input'
                : 'Waiting for your approval';
          const pauseStatus =
            node.type === 'input' ? 'paused_for_input' : 'paused_for_approval';
          const stepStatus =
            node.type === 'input' ? 'awaiting_input' : 'awaiting_approval';
          steps = updateStep(steps, node.id, {
            status: stepStatus,
            summary: msg,
          });
          this.persistSteps(
            run.id,
            node.id,
            steps,
            {
              lastNode: node.id,
              approvalMessage: node.type === 'approval' ? node.message : undefined,
              inputPrompt: node.type === 'input' ? node.prompt : undefined,
              inputFields: node.type === 'input' ? node.fields : undefined,
            },
            pauseStatus
          );
          return { runId: run.id, status: pauseStatus };
        }

        if (result === 'denied') {
          steps = updateStep(steps, node.id, {
            status: 'failed',
            summary: 'Approval denied',
            error: 'Approval denied',
            finishedAt: Date.now(),
          });
          this.persistSteps(run.id, node.id, steps, {
            lastNode: node.id,
            [`node_${node.id}`]: 'denied',
          });
          const failed = this.checkpoints.fail(run.id, `Approval denied at node ${node.id}`);
          this.emitProgress(failed);
          return { runId: run.id, status: 'failed' };
        }

        if (result === 'cancelled') {
          steps = updateStep(steps, node.id, {
            status: 'failed',
            summary: 'Input cancelled',
            error: 'Input cancelled',
            finishedAt: Date.now(),
          });
          this.persistSteps(run.id, node.id, steps, {
            lastNode: node.id,
            [`node_${node.id}`]: 'cancelled',
          });
          const failed = this.checkpoints.fail(run.id, `Input cancelled at node ${node.id}`);
          this.emitProgress(failed);
          return { runId: run.id, status: 'failed' };
        }

        steps = readSteps(this.checkpoints, run.id, steps);
        const doneStep = steps.find((s) => s.nodeId === node.id);
        const summaryFromOutput =
          doneStep?.output &&
          typeof doneStep.output === 'object' &&
          doneStep.output !== null &&
          typeof (doneStep.output as { summary?: unknown }).summary === 'string'
            ? String((doneStep.output as { summary: string }).summary).slice(0, 500)
            : null;
        steps = updateStep(steps, node.id, {
          status: 'success',
          summary: summaryFromOutput || this.successSummary(node),
          finishedAt: Date.now(),
        });
        this.persistSteps(run.id, node.id, steps, {
          lastNode: node.id,
          [`node_${node.id}`]: 'ok',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps = readSteps(this.checkpoints, run.id, steps);
        steps = updateStep(steps, node.id, {
          status: 'failed',
          summary: message,
          error: message,
          finishedAt: Date.now(),
        });
        this.persistSteps(run.id, node.id, steps, { lastNode: node.id });
        const failed = this.checkpoints.fail(run.id, message);
        this.emitProgress(failed);
        return { runId: run.id, status: 'failed' };
      }
    }

    const completed = this.persistSteps(
      run.id,
      'done',
      steps,
      { finished: true },
      'completed'
    );
    this.emitProgress(completed);
    log(`[Workflow] Completed ${workflow.name} run ${run.id}`);
    return { runId: run.id, status: 'completed' };
  }

  private successSummary(node: WorkflowNode): string {
    if (node.type === 'agent') return 'Agent step finished';
    if (node.type === 'tool') return `Tool ${node.toolName} finished`;
    if (node.type === 'approval') return 'Approved';
    if (node.type === 'input') return 'Input collected';
    if (node.type === 'notify') return 'Notification sent';
    return 'Done';
  }

  private async executeNode(
    workflow: WorkflowDefinition,
    runId: string,
    node: WorkflowNode
  ): Promise<'ok' | 'paused' | 'denied' | 'cancelled'> {
    if (node.type === 'agent') {
      const stepsBefore = getWorkflowRunSteps(this.checkpoints.get(runId)?.payload || {});
      const priors = extractPriorAgentResults(stepsBefore);
      const prompt = composeAgentStepPrompt(node.prompt, priors);
      const result = await this.api.runAgentStep({
        workflowId: workflow.id,
        runId,
        nodeId: node.id,
        prompt,
        model: node.model,
        provider: node.provider,
        stepLabel: node.label,
      });
      const steps = getWorkflowRunSteps(this.checkpoints.get(runId)?.payload || {});
      const summary = result.summary?.trim() || undefined;
      const next = updateStep(steps, node.id, {
        summary: summary ? summary.slice(0, 280) : undefined,
        output: truncateOutput({
          sessionId: result.sessionId ?? null,
          summary: summary ?? null,
          model: node.model ?? null,
        }),
      });
      this.persistSteps(runId, node.id, next, {
        sessionId: result.sessionId ?? null,
      });
      return 'ok';
    }

    if (node.type === 'tool') {
      const stepsBefore = getWorkflowRunSteps(this.checkpoints.get(runId)?.payload || {});
      const priors = extractPriorAgentResults(stepsBefore);
      const base = `Execute tool ${node.toolName} with args ${JSON.stringify(node.args || {})}. Report outcome briefly.`;
      const result = await this.api.runAgentStep({
        workflowId: workflow.id,
        runId,
        nodeId: node.id,
        prompt: composeAgentStepPrompt(base, priors),
        stepLabel: node.label || node.toolName,
      });
      const steps = getWorkflowRunSteps(this.checkpoints.get(runId)?.payload || {});
      const next = updateStep(steps, node.id, {
        output: truncateOutput({
          toolName: node.toolName,
          args: node.args,
          sessionId: result.sessionId ?? null,
          summary: result.summary ?? null,
        }),
      });
      this.persistSteps(runId, node.id, next, {
        sessionId: result.sessionId ?? null,
      });
      return 'ok';
    }

    if (node.type === 'approval') {
      const steps = getWorkflowRunSteps(this.checkpoints.get(runId)?.payload || {});
      const next = updateStep(steps, node.id, {
        status: 'awaiting_approval',
        summary: node.message || 'Waiting for your approval',
      });
      this.persistSteps(
        runId,
        node.id,
        next,
        { approvalMessage: node.message },
        'paused_for_approval'
      );
      const decision = await this.api.requestApproval({
        workflowId: workflow.id,
        runId,
        nodeId: node.id,
        message: node.message || node.label || 'Approve workflow step?',
      });
      if (decision !== 'allow') {
        return 'denied';
      }
      this.checkpoints.resume(runId);
      return 'ok';
    }

    if (node.type === 'input') {
      const steps = getWorkflowRunSteps(this.checkpoints.get(runId)?.payload || {});
      const next = updateStep(steps, node.id, {
        status: 'awaiting_input',
        summary: node.prompt || 'Waiting for your input',
      });
      this.persistSteps(
        runId,
        node.id,
        next,
        {
          inputPrompt: node.prompt,
          inputFields: node.fields,
          inputNodeId: node.id,
          inputLabel: node.label,
        },
        'paused_for_input'
      );
      const response = await this.api.requestUserInput({
        workflowId: workflow.id,
        runId,
        nodeId: node.id,
        prompt: node.prompt || node.label || 'Provide input to continue',
        fields: node.fields,
        label: node.label,
      });
      if (response.kind !== 'submitted') {
        return 'cancelled';
      }
      const summary = formatInputAnswersSummary(response.answers, node.fields);
      const after = getWorkflowRunSteps(this.checkpoints.get(runId)?.payload || {});
      const withOutput = updateStep(after, node.id, {
        summary: summary.slice(0, 280) || 'Input collected',
        output: truncateOutput({
          answers: response.answers,
          fields: node.fields,
          prompt: node.prompt,
          summary: summary || 'Input collected',
        }),
      });
      this.persistSteps(runId, node.id, withOutput, {
        lastInputAnswers: response.answers,
      });
      this.checkpoints.resume(runId);
      return 'ok';
    }

    if (node.type === 'notify') {
      await this.api.notify?.({
        workflowId: workflow.id,
        runId,
        nodeId: node.id,
        message: node.message,
        channel: node.channel,
      });
      const steps = getWorkflowRunSteps(this.checkpoints.get(runId)?.payload || {});
      const next = updateStep(steps, node.id, {
        output: truncateOutput({ message: node.message, channel: node.channel }),
      });
      this.persistSteps(runId, node.id, next);
      return 'ok';
    }

    logWarn(`[Workflow] Unknown node type skipped: ${(node as WorkflowNode).type}`);
    return 'ok';
  }
}
