/**
 * Durable checkpointed orchestration (M3).
 */

export type CheckpointRunKind = 'goal_tick' | 'schedule' | 'subagent' | 'workflow';

export type CheckpointRunStatus =
  | 'running'
  | 'paused_for_approval'
  | 'paused_for_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stuck';

export interface CheckpointPayload {
  /** Free-form JSON-serializable progress. */
  [key: string]: unknown;
}

export interface CheckpointRun {
  id: string;
  kind: CheckpointRunKind;
  stepId: string;
  status: CheckpointRunStatus;
  payload: CheckpointPayload;
  error: string | null;
  costUsd: number | null;
  /** Optional binding to a chat session (goals / continuations). */
  sessionId: string | null;
  /** Optional binding to scheduled task or workflow id. */
  sourceId: string | null;
  title: string | null;
  stuckSummary: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface CheckpointStartInput {
  kind: CheckpointRunKind;
  stepId?: string;
  payload?: CheckpointPayload;
  sessionId?: string | null;
  sourceId?: string | null;
  title?: string | null;
}

/** Runs older than this while `running` are marked stuck on boot/scan. */
export const CHECKPOINT_STUCK_MS = 30 * 60_000;

export const RESUMABLE_CHECKPOINT_STATUSES: CheckpointRunStatus[] = [
  'running',
  'paused_for_approval',
  'paused_for_input',
];
