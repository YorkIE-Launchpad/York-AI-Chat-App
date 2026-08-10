/**
 * Shared status-dot / label language for workflow runs (OpenHuman-style dots, not bars).
 */
import type { WorkflowRunDisplayStatus, WorkflowRunStepStatus } from '../../../shared/workflows';
import {
  resolveWorkflowRunDisplayStatus,
  workflowRunDisplayLabel,
} from '../../../shared/workflows';
import type { CheckpointRunStatus } from '../../../shared/orchestration';

export function runDisplayStatus(status: CheckpointRunStatus): WorkflowRunDisplayStatus {
  return resolveWorkflowRunDisplayStatus(status);
}

export function runStatusLabel(status: CheckpointRunStatus | WorkflowRunDisplayStatus): string {
  return workflowRunDisplayLabel(status as WorkflowRunDisplayStatus);
}

export function runStatusDotClass(status: CheckpointRunStatus | WorkflowRunDisplayStatus): string {
  const display =
    status === 'paused_for_approval'
      ? 'needs_approval'
      : resolveWorkflowRunDisplayStatus(
          status === 'needs_approval' ? 'paused_for_approval' : (status as CheckpointRunStatus)
        );
  switch (display) {
    case 'running':
      return 'bg-accent animate-pulse';
    case 'completed':
      return 'bg-accent';
    case 'failed':
      return 'bg-error';
    case 'cancelled':
      return 'bg-text-muted';
    case 'stuck':
      return 'bg-accent/70 animate-pulse';
    case 'needs_approval':
      return 'bg-accent animate-pulse';
    default:
      return 'bg-text-muted';
  }
}

export function runStatusPillClass(status: CheckpointRunStatus | WorkflowRunDisplayStatus): string {
  const display =
    status === 'paused_for_approval' || status === 'needs_approval'
      ? 'needs_approval'
      : (status as WorkflowRunDisplayStatus);
  switch (display) {
    case 'running':
      return 'bg-accent/12 text-accent ring-1 ring-accent/25';
    case 'completed':
      return 'bg-accent/12 text-accent ring-1 ring-accent/25';
    case 'failed':
      return 'bg-error/10 text-error ring-1 ring-error/25';
    case 'cancelled':
      return 'bg-surface-muted text-text-muted ring-1 ring-border-muted';
    case 'stuck':
      return 'bg-accent/15 text-accent ring-1 ring-accent/30';
    case 'needs_approval':
      return 'bg-accent/15 text-accent ring-1 ring-accent/35';
    default:
      return 'bg-surface-muted text-text-secondary ring-1 ring-border-muted';
  }
}

export function stepStatusDotClass(status: WorkflowRunStepStatus): string {
  switch (status) {
    case 'running':
      return 'bg-accent animate-pulse';
    case 'success':
      return 'bg-accent';
    case 'failed':
      return 'bg-error';
    case 'awaiting_approval':
      return 'bg-accent animate-pulse';
    case 'skipped':
      return 'bg-text-muted/60';
    case 'pending':
    default:
      return 'bg-border';
  }
}

export function relativeTime(ts: number): string {
  const ms = Date.now() - ts;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
