/**
 * Workflow service — CRUD, propose draft, run via checkpoint executor.
 */
import type { DatabaseInstance } from '../db/database';
import type { CheckpointService } from '../orchestration/checkpoint-service';
import type { CheckpointRun } from '../../shared/orchestration';
import type {
  WorkflowBinding,
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowGraph,
  WorkflowNode,
  WorkflowRunSummary,
} from '../../shared/workflows';
import {
  buildWorkflowTitle,
  createEmptyWorkflowGraph,
  normalizeWorkflowBinding,
} from '../../shared/workflows';
import {
  buildWorkflowFromDescription,
  buildWorkflowFromGraphInput,
  getCronTriggerConfig,
  validateWorkflowGraph,
  WorkflowGraphValidationError,
} from './workflow-build';
import { WorkflowStore, type WorkflowUpdateFields } from './workflow-store';
import { WorkflowExecutor, type WorkflowExecutorApi } from './workflow-executor';
import { log, logWarn } from '../utils/logger';

export interface WorkflowScheduleBridge {
  /** Create or update a schedule that runs this workflow id; return task id. */
  upsertCronSchedule: (input: {
    workflowId: string;
    workflowName: string;
    times: string[];
    weekdays: number[];
    existingTaskId: string | null;
  }) => Promise<string>;
  /** Disable/delete schedule when workflow disabled or deleted. */
  removeSchedule: (taskId: string) => Promise<void>;
}

export type WorkflowTitleResolver = (description: string) => Promise<string | null>;

function applyBindingToInput(
  input: WorkflowDefinitionInput,
  binding?: Partial<WorkflowBinding> | null
): WorkflowDefinitionInput {
  const b = normalizeWorkflowBinding(binding ?? input);
  return {
    ...input,
    name: buildWorkflowTitle(input.name),
    division: b.division,
    hubProjectId: b.hubProjectId ?? null,
    hubProjectName: b.hubProjectName ?? null,
    launchpadProjectId: b.launchpadProjectId ?? null,
    launchpadProjectName: b.launchpadProjectName ?? null,
    folderId: b.folderId ?? null,
    folderName: b.folderName ?? null,
    canonicalKey: b.canonicalKey ?? null,
  };
}

export class WorkflowService {
  private readonly store: WorkflowStore;
  private executor: WorkflowExecutor | null = null;
  private scheduleBridge: WorkflowScheduleBridge | null = null;
  private titleResolver: WorkflowTitleResolver | null = null;

  constructor(
    db: DatabaseInstance,
    private readonly checkpoints: CheckpointService
  ) {
    this.store = new WorkflowStore(db);
  }

  configureExecutor(api: WorkflowExecutorApi): void {
    this.executor = new WorkflowExecutor(this.checkpoints, api);
  }

  setScheduleBridge(bridge: WorkflowScheduleBridge | null): void {
    this.scheduleBridge = bridge;
  }

  setTitleResolver(resolver: WorkflowTitleResolver | null): void {
    this.titleResolver = resolver;
  }

  listRuns(workflowId: string, limit = 40): CheckpointRun[] {
    return this.checkpoints.listBySource(workflowId, 'workflow', limit);
  }

  listAllRuns(limit = 50): WorkflowRunSummary[] {
    const runs = this.checkpoints.listByKind('workflow', limit);
    return runs.map((run) => {
      const workflowId = String(run.sourceId || run.payload.workflowId || '');
      const def = workflowId ? this.store.get(workflowId) : null;
      return {
        run,
        workflowId,
        workflowName: def?.name || run.title || 'Unknown workflow',
      };
    });
  }

  getRun(runId: string): CheckpointRun | null {
    const run = this.checkpoints.get(runId);
    if (!run || run.kind !== 'workflow') return null;
    return run;
  }

  list(): WorkflowDefinition[] {
    return this.store.list();
  }

  get(id: string): WorkflowDefinition | null {
    return this.store.get(id);
  }

  create(input: WorkflowDefinitionInput): WorkflowDefinition {
    validateWorkflowGraph(input.graph);
    this.assertApprovalGates(input.graph);
    const created = this.store.create(
      applyBindingToInput({ ...input, status: input.status || 'draft' })
    );
    if (created.status === 'enabled') {
      void this.syncScheduleForWorkflow(created).catch((err) => {
        logWarn('[Workflow] Failed to sync schedule on create', err);
      });
    }
    return created;
  }

  update(id: string, updates: WorkflowUpdateFields): WorkflowDefinition | null {
    const existing = this.store.get(id);
    if (!existing) return null;

    if (updates.graph) {
      validateWorkflowGraph(updates.graph);
      this.assertApprovalGates(updates.graph);
    }

    const next = this.store.update(id, {
      ...updates,
      ...(updates.name !== undefined ? { name: buildWorkflowTitle(updates.name) } : {}),
    });
    if (!next) return null;

    if (updates.status !== undefined || updates.graph !== undefined) {
      void this.syncScheduleForWorkflow(next).catch((err) => {
        logWarn('[Workflow] Failed to sync schedule', err);
      });
    }
    return next;
  }

  delete(id: string): boolean {
    const existing = this.store.get(id);
    if (existing?.scheduleTaskId && this.scheduleBridge) {
      void this.scheduleBridge.removeSchedule(existing.scheduleTaskId).catch(() => undefined);
    }
    return this.store.delete(id);
  }

  /**
   * Agent / UI: draft from natural language.
   * De-duplicates identical draft descriptions so re-runs don't spam the library.
   */
  async proposeFromDescription(
    description: string,
    options?: { binding?: Partial<WorkflowBinding> | null }
  ): Promise<{
    workflow: WorkflowDefinition;
    reused: boolean;
  }> {
    const raw = description.trim();
    const existing = this.findDuplicateDraft(raw);
    if (existing) {
      log(`[Workflow] Reusing draft ${existing.id} for identical description`);
      return { workflow: existing, reused: true };
    }
    const built = buildWorkflowFromDescription(raw);
    let name = built.input.name;
    if (this.titleResolver) {
      try {
        const generated = await this.titleResolver(raw);
        if (generated?.trim()) name = buildWorkflowTitle(generated);
      } catch (err) {
        logWarn('[Workflow] Title generation failed; using deriveName', err);
      }
    }
    const draft = this.store.create(
      applyBindingToInput(
        {
          ...built.input,
          name,
        },
        options?.binding
      )
    );
    log(
      `[Workflow] Proposed draft ${draft.id}: ${draft.name} | ${built.summary.join(' · ')}${
        built.warnings.length ? ` | warnings: ${built.warnings.join('; ')}` : ''
      } | space=${draft.division}`
    );
    return { workflow: draft, reused: false };
  }

  /**
   * Agent: propose with explicit graph. Persists as draft only — never enables.
   */
  proposeFromGraph(input: {
    name: string;
    description?: string;
    graph: WorkflowGraph;
    requireApproval?: boolean;
    binding?: Partial<WorkflowBinding> | null;
  }): { workflow: WorkflowDefinition; summary: string[]; warnings: string[]; reused: boolean } {
    const built = buildWorkflowFromGraphInput(input);
    const key = `${built.input.name}\n${built.input.description || ''}`.trim();
    const existing = this.findDuplicateDraft(key, built.input.name);
    if (existing) {
      log(`[Workflow] Reusing graph draft ${existing.id}`);
      return {
        workflow: existing,
        summary: built.summary,
        warnings: built.warnings,
        reused: true,
      };
    }
    const workflow = this.store.create(
      applyBindingToInput(
        {
          ...built.input,
          name: buildWorkflowTitle(input.name || built.input.name),
        },
        input.binding
      )
    );
    log(`[Workflow] Proposed graph draft ${workflow.id}: ${workflow.name}`);
    return {
      workflow,
      summary: built.summary,
      warnings: built.warnings,
      reused: false,
    };
  }

  private findDuplicateDraft(
    description: string,
    name?: string
  ): WorkflowDefinition | null {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const wantDesc = norm(description);
    const wantName = name ? norm(name) : '';
    return (
      this.store.list().find((w) => {
        if (w.status !== 'draft') return false;
        if (wantDesc && norm(w.description) === wantDesc) return true;
        if (wantName && norm(w.name) === wantName && norm(w.description) === wantDesc) {
          return true;
        }
        return false;
      }) || null
    );
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

  /** Ensure approval nodes always gate. */
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

  private async syncScheduleForWorkflow(workflow: WorkflowDefinition): Promise<void> {
    if (!this.scheduleBridge) return;

    const cron = getCronTriggerConfig(workflow.graph);
    if (workflow.status === 'enabled' && cron) {
      const taskId = await this.scheduleBridge.upsertCronSchedule({
        workflowId: workflow.id,
        workflowName: workflow.name,
        times: cron.times,
        weekdays: cron.weekdays,
        existingTaskId: workflow.scheduleTaskId,
      });
      if (taskId !== workflow.scheduleTaskId) {
        this.store.update(workflow.id, { scheduleTaskId: taskId });
      }
      return;
    }

    if (workflow.scheduleTaskId) {
      await this.scheduleBridge.removeSchedule(workflow.scheduleTaskId);
      if (workflow.status !== 'enabled') {
        this.store.update(workflow.id, { scheduleTaskId: null });
      }
    }
  }
}

export { WorkflowGraphValidationError };
