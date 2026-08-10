/**
 * Checkpoint service facade for M3 durable orchestration.
 */
import type { DatabaseInstance } from '../db/database';
import type {
  CheckpointPayload,
  CheckpointRun,
  CheckpointRunStatus,
  CheckpointStartInput,
} from '../../shared/orchestration';
import { log, logWarn } from '../utils/logger';
import { CheckpointStore } from './checkpoint-store';

export type OnStuckReport = (run: CheckpointRun, summary: string) => void;

export class CheckpointService {
  private readonly store: CheckpointStore;
  private onStuck: OnStuckReport | null = null;
  private resumers = new Map<string, (run: CheckpointRun) => Promise<void>>();

  constructor(db: DatabaseInstance) {
    this.store = new CheckpointStore(db);
  }

  setStuckHandler(handler: OnStuckReport | null): void {
    this.onStuck = handler;
  }

  /** Register a kind-specific resume handler (goal_tick, schedule, workflow, …). */
  registerResumer(kind: string, handler: (run: CheckpointRun) => Promise<void>): void {
    this.resumers.set(kind, handler);
  }

  startRun(input: CheckpointStartInput): CheckpointRun {
    const run = this.store.startRun(input);
    log(`[Checkpoint] Started ${run.kind} run ${run.id} step=${run.stepId}`);
    return run;
  }

  checkpoint(
    id: string,
    stepId: string,
    payload?: CheckpointPayload,
    status?: CheckpointRunStatus
  ): CheckpointRun | null {
    return this.store.checkpoint(id, stepId, payload, status);
  }

  fail(id: string, error: string): CheckpointRun | null {
    logWarn(`[Checkpoint] Fail ${id}: ${error}`);
    return this.store.fail(id, error);
  }

  cancel(id: string): CheckpointRun | null {
    return this.store.cancel(id);
  }

  resume(id: string): CheckpointRun | null {
    return this.store.resume(id);
  }

  get(id: string): CheckpointRun | null {
    return this.store.get(id);
  }

  list(limit?: number): CheckpointRun[] {
    return this.store.list(limit);
  }

  listByKind(kind: CheckpointRun['kind'], limit?: number): CheckpointRun[] {
    return this.store.listByKind(kind, limit);
  }

  listBySource(
    sourceId: string,
    kind?: CheckpointRun['kind'],
    limit?: number
  ): CheckpointRun[] {
    return this.store.listBySource(sourceId, kind, limit);
  }

  listResumable(): CheckpointRun[] {
    return this.store.listResumable();
  }

  findActiveForSession(sessionId: string): CheckpointRun | null {
    return this.store.findActiveForSession(sessionId);
  }

  findActiveForSource(sourceId: string, kind?: CheckpointRun['kind']): CheckpointRun | null {
    return this.store.findActiveForSource(sourceId, kind);
  }

  /**
   * Scan for stuck runs, emit reports, then resume `running` / `paused_for_approval`.
   */
  async bootResume(): Promise<{ stuck: number; resumed: number }> {
    const newlyStuck = this.store.detectStuck();
    for (const run of newlyStuck) {
      if (run.stuckSummary) {
        this.onStuck?.(run, run.stuckSummary);
      }
    }

    const resumable = this.store.listResumable();
    let resumed = 0;
    for (const run of resumable) {
      const handler = this.resumers.get(run.kind);
      if (!handler) continue;
      try {
        this.store.resume(run.id);
        await handler(run);
        resumed += 1;
        log(`[Checkpoint] Resumed ${run.kind} run ${run.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.fail(run.id, `Resume failed: ${message}`);
      }
    }
    return { stuck: newlyStuck.length, resumed };
  }

  /**
   * Mark approval pause — used by workflow approval nodes.
   */
  pauseForApproval(id: string, stepId: string, payload?: CheckpointPayload): CheckpointRun | null {
    return this.store.checkpoint(id, stepId, payload, 'paused_for_approval');
  }
}
