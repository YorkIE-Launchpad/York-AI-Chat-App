/**
 * Checkpoint store — SQLite durable runs for goals, schedules, subagents, workflows.
 */
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance } from '../db/database';
import type {
  CheckpointPayload,
  CheckpointRun,
  CheckpointRunKind,
  CheckpointRunStatus,
  CheckpointStartInput,
} from '../../shared/orchestration';
import { CHECKPOINT_STUCK_MS, RESUMABLE_CHECKPOINT_STATUSES } from '../../shared/orchestration';

export interface CheckpointRunRow {
  id: string;
  kind: string;
  step_id: string;
  status: string;
  payload: string;
  error: string | null;
  cost_usd: number | null;
  session_id: string | null;
  source_id: string | null;
  title: string | null;
  stuck_summary: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function parsePayload(raw: string | null | undefined): CheckpointPayload {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as CheckpointPayload)
      : {};
  } catch {
    return {};
  }
}

export function mapCheckpointRow(row: CheckpointRunRow): CheckpointRun {
  return {
    id: row.id,
    kind: row.kind as CheckpointRunKind,
    stepId: row.step_id,
    status: row.status as CheckpointRunStatus,
    payload: parsePayload(row.payload),
    error: row.error,
    costUsd: row.cost_usd,
    sessionId: row.session_id,
    sourceId: row.source_id,
    title: row.title,
    stuckSummary: row.stuck_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class CheckpointStore {
  constructor(private readonly db: DatabaseInstance) {}

  startRun(input: CheckpointStartInput): CheckpointRun {
    const now = Date.now();
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO checkpoint_runs
         (id, kind, step_id, status, payload, error, cost_usd, session_id, source_id, title, stuck_summary, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, NULL)`
      )
      .run(
        id,
        input.kind,
        input.stepId || 'start',
        'running',
        JSON.stringify(input.payload || {}),
        input.sessionId ?? null,
        input.sourceId ?? null,
        input.title ?? null,
        now,
        now
      );
    return this.get(id)!;
  }

  get(id: string): CheckpointRun | null {
    const row = this.db.prepare(`SELECT * FROM checkpoint_runs WHERE id = ?`).get(id) as
      | CheckpointRunRow
      | undefined;
    return row ? mapCheckpointRow(row) : null;
  }

  list(limit = 50): CheckpointRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM checkpoint_runs ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as CheckpointRunRow[];
    return rows.map(mapCheckpointRow);
  }

  listByKind(kind: CheckpointRunKind, limit = 50): CheckpointRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM checkpoint_runs WHERE kind = ? ORDER BY updated_at DESC LIMIT ?`
      )
      .all(kind, limit) as CheckpointRunRow[];
    return rows.map(mapCheckpointRow);
  }

  listBySource(
    sourceId: string,
    kind?: CheckpointRunKind,
    limit = 40
  ): CheckpointRun[] {
    if (kind) {
      const rows = this.db
        .prepare(
          `SELECT * FROM checkpoint_runs
           WHERE source_id = ? AND kind = ?
           ORDER BY updated_at DESC LIMIT ?`
        )
        .all(sourceId, kind, limit) as CheckpointRunRow[];
      return rows.map(mapCheckpointRow);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM checkpoint_runs
         WHERE source_id = ?
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(sourceId, limit) as CheckpointRunRow[];
    return rows.map(mapCheckpointRow);
  }

  listResumable(): CheckpointRun[] {
    const placeholders = RESUMABLE_CHECKPOINT_STATUSES.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM checkpoint_runs WHERE status IN (${placeholders}) ORDER BY updated_at ASC`
      )
      .all(...RESUMABLE_CHECKPOINT_STATUSES) as CheckpointRunRow[];
    return rows.map(mapCheckpointRow);
  }

  checkpoint(
    id: string,
    stepId: string,
    payload?: CheckpointPayload,
    status: CheckpointRunStatus = 'running'
  ): CheckpointRun | null {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = { ...existing.payload, ...(payload || {}) };
    const now = Date.now();
    const completed =
      status === 'completed' || status === 'failed' || status === 'cancelled' ? now : null;
    this.db
      .prepare(
        `UPDATE checkpoint_runs
         SET step_id = ?, status = ?, payload = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
         WHERE id = ?`
      )
      .run(stepId, status, JSON.stringify(merged), now, completed, id);
    return this.get(id);
  }

  fail(id: string, error: string): CheckpointRun | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE checkpoint_runs
         SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(error, now, now, id);
    return this.get(id);
  }

  cancel(id: string): CheckpointRun | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE checkpoint_runs
         SET status = 'cancelled', updated_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(now, now, id);
    return this.get(id);
  }

  resume(id: string, stepId?: string): CheckpointRun | null {
    const existing = this.get(id);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE checkpoint_runs
         SET status = 'running', step_id = ?, updated_at = ?, completed_at = NULL, stuck_summary = NULL
         WHERE id = ?`
      )
      .run(stepId || existing.stepId, now, id);
    return this.get(id);
  }

  markStuck(id: string, summary: string): CheckpointRun | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE checkpoint_runs
         SET status = 'stuck', stuck_summary = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(summary, now, id);
    return this.get(id);
  }

  /**
   * Flag long-running entries as stuck and return them for reporting.
   */
  detectStuck(now = Date.now()): CheckpointRun[] {
    const cutoff = now - CHECKPOINT_STUCK_MS;
    const stuck = this.listResumable().filter(
      (run) => run.status === 'running' && run.updatedAt < cutoff
    );
    for (const run of stuck) {
      const summary = [
        `Run ${run.id} (${run.kind}) stuck at step "${run.stepId}".`,
        run.title ? `Title: ${run.title}` : '',
        `Last update: ${new Date(run.updatedAt).toISOString()}.`,
        'Likely root cause: process killed or tick never completed; resume to continue from last step.',
      ]
        .filter(Boolean)
        .join(' ');
      this.markStuck(run.id, summary);
    }
    return this.list(200).filter((r) => r.status === 'stuck' && r.updatedAt >= now - 1000);
  }

  findActiveForSession(sessionId: string): CheckpointRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM checkpoint_runs
         WHERE session_id = ? AND status IN ('running', 'paused_for_approval')
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(sessionId) as CheckpointRunRow | undefined;
    return row ? mapCheckpointRow(row) : null;
  }

  findActiveForSource(sourceId: string, kind?: CheckpointRunKind): CheckpointRun | null {
    if (kind) {
      const row = this.db
        .prepare(
          `SELECT * FROM checkpoint_runs
           WHERE source_id = ? AND kind = ? AND status IN ('running', 'paused_for_approval')
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(sourceId, kind) as CheckpointRunRow | undefined;
      return row ? mapCheckpointRow(row) : null;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM checkpoint_runs
         WHERE source_id = ? AND status IN ('running', 'paused_for_approval')
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(sourceId) as CheckpointRunRow | undefined;
    return row ? mapCheckpointRow(row) : null;
  }
}
