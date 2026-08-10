/**
 * Workflow service — CRUD, propose draft, run via checkpoint executor.
 */
import type { DatabaseInstance } from '../db/database';
import type { CheckpointService } from '../orchestration/checkpoint-service';
import type {
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowGraph,
  WorkflowNode,
} from '../../shared/workflows';
import {
  WORKFLOW_SCHEMA_VERSION,
  createEmptyWorkflowGraph,
} from '../../shared/workflows';
import { WorkflowStore } from './workflow-store';
import { WorkflowExecutor, type WorkflowExecutorApi } from './workflow-executor';
import { log } from '../utils/logger';

export class WorkflowService {
  private readonly store: WorkflowStore;
  private executor: WorkflowExecutor | null = null;

  constructor(
    db: DatabaseInstance,
    private readonly checkpoints: CheckpointService
  ) {
    this.store = new WorkflowStore(db);
  }

  configureExecutor(api: WorkflowExecutorApi): void {
    this.executor = new WorkflowExecutor(this.checkpoints, api);
  }

  list(): WorkflowDefinition[] {
    return this.store.list();
  }

  get(id: string): WorkflowDefinition | null {
    return this.store.get(id);
  }

  create(input: WorkflowDefinitionInput): WorkflowDefinition {
    return this.store.create(input);
  }

  update(
    id: string,
    updates: Partial<
      Pick<WorkflowDefinition, 'name' | 'description' | 'status' | 'graph' | 'scheduleTaskId'>
    >
  ): WorkflowDefinition | null {
    return this.store.update(id, updates);
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  /**
   * Agent-facing: draft a simple linear automation from natural language.
   */
  proposeFromDescription(description: string): WorkflowDefinition {
    const name = description.trim().slice(0, 80) || 'Proposed workflow';
    const graph: WorkflowGraph = {
      version: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        {
          id: 'trigger_1',
          type: 'trigger',
          label: 'Trigger',
          trigger: 'manual',
          x: 40,
          y: 60,
        },
        {
          id: 'agent_1',
          type: 'agent',
          label: 'Agent step',
          prompt: description.trim(),
          x: 240,
          y: 60,
        },
        {
          id: 'approval_1',
          type: 'approval',
          label: 'Approve side effects',
          message: `Approve running: ${name}?`,
          requireApproval: true,
          x: 440,
          y: 60,
        },
        {
          id: 'notify_1',
          type: 'notify',
          label: 'Notify',
          message: `Workflow finished: ${name}`,
          x: 640,
          y: 60,
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger_1', to: 'agent_1' },
        { id: 'e2', from: 'agent_1', to: 'approval_1' },
        { id: 'e3', from: 'approval_1', to: 'notify_1' },
      ],
    };

    const draft = this.store.create({
      name,
      description: description.trim(),
      status: 'draft',
      graph,
    });
    log(`[Workflow] Proposed draft ${draft.id}: ${name}`);
    return draft;
  }

  async run(id: string): Promise<{ runId: string; status: string }> {
    const workflow = this.store.get(id);
    if (!workflow) throw new Error('Workflow not found');
    if (!this.executor) throw new Error('Workflow executor not configured');
    if (workflow.status === 'disabled') throw new Error('Workflow is disabled');
    return this.executor.startWorkflow(workflow);
  }

  async resumeRun(runId: string): Promise<{ runId: string; status: string }> {
    if (!this.executor) throw new Error('Workflow executor not configured');
    const run = this.checkpoints.get(runId);
    if (!run || run.kind !== 'workflow') throw new Error('Workflow run not found');
    const workflowId = String(run.sourceId || run.payload.workflowId || '');
    const workflow = this.store.get(workflowId);
    if (!workflow) throw new Error('Workflow definition missing for run');
    return this.executor.startWorkflow(workflow, {
      resumeRunId: runId,
      fromStepId: run.stepId,
    });
  }

  /** Ensure a node is approval-gated when present. */
  assertApprovalGates(graph: WorkflowGraph): void {
    for (const node of graph.nodes) {
      if (node.type === 'approval' && !(node as { requireApproval?: boolean }).requireApproval) {
        (node as WorkflowNode & { requireApproval: true }).requireApproval = true;
      }
    }
  }

  emptyGraph(): WorkflowGraph {
    return createEmptyWorkflowGraph();
  }
}
