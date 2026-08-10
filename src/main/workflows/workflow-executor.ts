/**
 * Workflow executor — runs graph nodes on the checkpoint engine.
 */
import type { CheckpointService } from '../orchestration/checkpoint-service';
import type { WorkflowDefinition, WorkflowNode } from '../../shared/workflows';
import { topologicalOrder } from '../../shared/workflows';
import { log, logWarn } from '../utils/logger';

export interface WorkflowExecutorApi {
  /**
   * Run an agent prompt (usually via schedule session or bound session).
   * Return a session id when created/continued.
   */
  runAgentStep: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    prompt: string;
    model?: string;
  }) => Promise<{ sessionId?: string | null }>;
  /**
   * Request user approval (reuses permission UI path via host).
   * Must not auto-approve.
   */
  requestApproval: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    message: string;
  }) => Promise<'allow' | 'deny'>;
  notify?: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    message: string;
    channel?: string;
  }) => Promise<void>;
}

export class WorkflowExecutor {
  constructor(
    private readonly checkpoints: CheckpointService,
    private readonly api: WorkflowExecutorApi
  ) {}

  async startWorkflow(
    workflow: WorkflowDefinition,
    options?: { resumeRunId?: string; fromStepId?: string }
  ): Promise<{ runId: string; status: string }> {
    const run =
      options?.resumeRunId != null
        ? this.checkpoints.resume(options.resumeRunId)
        : this.checkpoints.startRun({
            kind: 'workflow',
            stepId: 'trigger',
            sourceId: workflow.id,
            title: workflow.name,
            payload: { workflowId: workflow.id, nodeResults: {} },
          });

    if (!run) {
      throw new Error('Failed to start workflow run');
    }

    const order = topologicalOrder(workflow.graph);
    const startIndex = options?.fromStepId
      ? Math.max(
          0,
          order.findIndex((id) => id === options.fromStepId)
        )
      : 0;

    for (let i = startIndex; i < order.length; i += 1) {
      const nodeId = order[i];
      const node = workflow.graph.nodes.find((n) => n.id === nodeId);
      if (!node) continue;

      // Skip trigger nodes at runtime after run starts
      if (node.type === 'trigger') {
        this.checkpoints.checkpoint(run.id, node.id, { lastNode: node.id });
        continue;
      }

      try {
        const result = await this.executeNode(workflow, run.id, node);
        if (result === 'paused') {
          return { runId: run.id, status: 'paused_for_approval' };
        }
        if (result === 'denied') {
          this.checkpoints.fail(run.id, `Approval denied at node ${node.id}`);
          return { runId: run.id, status: 'failed' };
        }
        this.checkpoints.checkpoint(run.id, node.id, {
          lastNode: node.id,
          [`node_${node.id}`]: 'ok',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.checkpoints.fail(run.id, message);
        return { runId: run.id, status: 'failed' };
      }
    }

    this.checkpoints.checkpoint(run.id, 'done', { finished: true }, 'completed');
    log(`[Workflow] Completed ${workflow.name} run ${run.id}`);
    return { runId: run.id, status: 'completed' };
  }

  private async executeNode(
    workflow: WorkflowDefinition,
    runId: string,
    node: WorkflowNode
  ): Promise<'ok' | 'paused' | 'denied'> {
    if (node.type === 'agent') {
      const result = await this.api.runAgentStep({
        workflowId: workflow.id,
        runId,
        nodeId: node.id,
        prompt: node.prompt,
        model: node.model,
      });
      this.checkpoints.checkpoint(runId, node.id, {
        sessionId: result.sessionId ?? null,
      });
      return 'ok';
    }

    if (node.type === 'tool') {
      // Tool nodes run via agent prompt shell in v1 (explicit invoke left to agent)
      await this.api.runAgentStep({
        workflowId: workflow.id,
        runId,
        nodeId: node.id,
        prompt: `Execute tool ${node.toolName} with args ${JSON.stringify(node.args || {})}. Report outcome briefly.`,
      });
      return 'ok';
    }

    if (node.type === 'approval') {
      this.checkpoints.pauseForApproval(runId, node.id, {
        approvalMessage: node.message,
      });
      // Host may re-enter from resume after user grants; on first encounter we block here.
      const decision = await this.api.requestApproval({
        workflowId: workflow.id,
        runId,
        nodeId: node.id,
        message: node.message || node.label || 'Approve workflow step?',
      });
      if (decision !== 'allow') {
        return 'denied';
      }
      this.checkpoints.checkpoint(runId, node.id, { approved: true }, 'running');
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
      return 'ok';
    }

    logWarn(`[Workflow] Unknown node type skipped: ${(node as WorkflowNode).type}`);
    return 'ok';
  }
}
