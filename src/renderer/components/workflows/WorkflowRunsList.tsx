/**
 * Compact scannable list of workflow runs (OpenHuman FlowRunsSidebar / drawer rows).
 */
import type { CheckpointRun } from '../../../shared/orchestration';
import {
  relativeTime,
  runDisplayStatus,
  runStatusDotClass,
  runStatusLabel,
  runStatusPillClass,
} from './WorkflowRunStatus';

export interface WorkflowRunsListProps {
  runs: CheckpointRun[];
  selectedRunId?: string | null;
  onSelect: (runId: string) => void;
  emptyLabel?: string;
  /** Optional subtitle under status (e.g. workflow name for all-runs view). */
  subtitleForRun?: (run: CheckpointRun) => string | null;
  loading?: boolean;
}

export function WorkflowRunsList({
  runs,
  selectedRunId,
  onSelect,
  emptyLabel = 'No runs yet.',
  subtitleForRun,
  loading,
}: WorkflowRunsListProps) {
  if (loading && runs.length === 0) {
    return <p className="px-1 py-4 text-center text-xs text-text-muted">Loading runs…</p>;
  }

  if (runs.length === 0) {
    return <p className="px-1 py-4 text-center text-xs text-text-muted">{emptyLabel}</p>;
  }

  return (
    <ul className="space-y-1">
      {runs.map((run) => {
        const display = runDisplayStatus(run.status);
        const selected = selectedRunId === run.id;
        const sub = subtitleForRun?.(run);
        return (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onSelect(run.id)}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                selected ? 'bg-accent/10 ring-1 ring-accent/25' : 'hover:bg-surface-hover'
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${runStatusDotClass(display)}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium ${runStatusPillClass(display)}`}
                  >
                    {runStatusLabel(display)}
                  </span>
                  <span className="truncate text-[11px] text-text-muted">
                    {relativeTime(run.updatedAt || run.createdAt)}
                  </span>
                </div>
                {sub ? (
                  <p className="mt-0.5 truncate text-xs text-text-secondary">{sub}</p>
                ) : (
                  <p className="mt-0.5 truncate font-mono text-[10px] text-text-muted" title={run.id}>
                    {run.id.slice(0, 8)}
                  </p>
                )}
                {run.error ? (
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-error">{run.error}</p>
                ) : null}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
