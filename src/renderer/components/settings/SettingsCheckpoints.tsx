/**
 * Durable checkpoint run list (M3) — resume/cancel.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CheckpointRun } from '../../../shared/orchestration';
import { SettingsContentSection } from './shared';

export function SettingsCheckpoints() {
  const [runs, setRuns] = useState<CheckpointRun[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.checkpoints) return;
    setRuns(await window.electronAPI.checkpoints.list(40));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resume = async (id: string) => {
    try {
      await window.electronAPI.checkpoints.resume(id);
      setStatus(`Resumed ${id.slice(0, 8)}…`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const cancel = async (id: string) => {
    await window.electronAPI.checkpoints.cancel(id);
    setStatus(`Cancelled ${id.slice(0, 8)}…`);
    await refresh();
  };

  return (
    <SettingsContentSection
      title="Durable runs"
      description="Checkpointed goal ticks, schedule fires, and workflow runs. Resume after restart or cancel stuck work."
    >
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-hover"
        >
          Refresh
        </button>
      </div>
      <div className="space-y-2">
        {runs.length === 0 ? (
          <p className="text-sm text-text-muted">No checkpoint runs yet.</p>
        ) : (
          runs.map((run) => (
            <div
              key={run.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-muted px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text-primary truncate">
                  {run.title || run.kind} · {run.status}
                </p>
                <p className="text-[11px] text-text-muted truncate">
                  {run.kind} · step {run.stepId} · {new Date(run.updatedAt).toLocaleString()}
                </p>
                {run.stuckSummary && (
                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                    {run.stuckSummary}
                  </p>
                )}
              </div>
              <div className="flex gap-1">
                {(run.status === 'running' ||
                  run.status === 'paused_for_approval' ||
                  run.status === 'stuck') && (
                  <button
                    type="button"
                    onClick={() => void resume(run.id)}
                    className="rounded-md bg-accent px-2 py-1 text-xs text-white"
                  >
                    Resume
                  </button>
                )}
                {run.status !== 'completed' &&
                  run.status !== 'cancelled' &&
                  run.status !== 'failed' && (
                    <button
                      type="button"
                      onClick={() => void cancel(run.id)}
                      className="rounded-md border border-border px-2 py-1 text-xs"
                    >
                      Cancel
                    </button>
                  )}
              </div>
            </div>
          ))
        )}
      </div>
      {status && <p className="mt-2 text-xs text-text-muted">{status}</p>}
    </SettingsContentSection>
  );
}
