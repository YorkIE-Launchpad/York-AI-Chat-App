/**
 * Durable checkpoint run list (M3) — resume/cancel.
 * Includes OpenHuman-style aggregate “All workflow runs” section.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CheckpointRun } from '../../../shared/orchestration';
import type { WorkflowRunSummary } from '../../../shared/workflows';
import { WorkflowRunInspector } from '../workflows/WorkflowRunInspector';
import { WorkflowRunsList } from '../workflows/WorkflowRunsList';
import { useWorkflowRunsLiveRefresh } from '../workflows/useWorkflowRunsLiveRefresh';
import {
  runDisplayStatus,
  runStatusLabel,
} from '../workflows/WorkflowRunStatus';
import { SettingsContentSection } from './shared';

export function SettingsCheckpoints() {
  const [runs, setRuns] = useState<CheckpointRun[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.checkpoints) return;
    setRuns(await window.electronAPI.checkpoints.list(40));
  }, []);

  const refreshWorkflowRuns = useCallback(async () => {
    if (!window.electronAPI?.workflows?.listAllRuns) {
      setWorkflowRuns([]);
      return;
    }
    setWorkflowRuns(await window.electronAPI.workflows.listAllRuns(50));
  }, []);

  useEffect(() => {
    void refresh();
    void refreshWorkflowRuns();
  }, [refresh, refreshWorkflowRuns]);

  const workflowCheckpointRuns = useMemo(
    () => workflowRuns.map((w) => w.run),
    [workflowRuns]
  );
  const nameByRunId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of workflowRuns) {
      map.set(item.run.id, item.workflowName);
    }
    return map;
  }, [workflowRuns]);

  useWorkflowRunsLiveRefresh(workflowCheckpointRuns, () => {
    void refreshWorkflowRuns();
    void refresh();
  });

  // Also live-refresh non-workflow checkpoints that are active
  useWorkflowRunsLiveRefresh(
    runs.filter((r) => r.kind !== 'workflow'),
    refresh
  );

  const resume = async (id: string) => {
    try {
      await window.electronAPI.checkpoints.resume(id);
      setStatus(`Resumed ${id.slice(0, 8)}…`);
      await refresh();
      await refreshWorkflowRuns();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const cancel = async (id: string) => {
    await window.electronAPI.checkpoints.cancel(id);
    setStatus(`Cancelled ${id.slice(0, 8)}…`);
    await refresh();
    await refreshWorkflowRuns();
  };

  const otherRuns = runs.filter((r) => r.kind !== 'workflow');

  return (
    <div className="space-y-6">
      <SettingsContentSection
        title="Workflow runs"
        description="Every workflow run across all automations, newest first. Click a row for the step timeline."
      >
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={() => void refreshWorkflowRuns()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-hover"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>
        <WorkflowRunsList
          runs={workflowCheckpointRuns}
          selectedRunId={selectedRunId}
          onSelect={setSelectedRunId}
          emptyLabel="No workflow runs yet. Start one from Settings → Workflows."
          subtitleForRun={(run) => nameByRunId.get(run.id) || run.title || null}
        />
      </SettingsContentSection>

      <SettingsContentSection
        title="Durable runs"
        description="Checkpointed goal ticks, schedule fires, and other long-running work. Resume after restart or cancel stuck work."
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
          {otherRuns.length === 0 ? (
            <p className="text-sm text-text-muted">No non-workflow checkpoint runs yet.</p>
          ) : (
            otherRuns.map((run) => (
              <div
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-muted px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text-primary">
                    {run.title || run.kind} · {runStatusLabel(runDisplayStatus(run.status))}
                  </p>
                  <p className="truncate text-[11px] text-text-muted">
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

      <WorkflowRunInspector
        runId={selectedRunId}
        onClose={() => setSelectedRunId(null)}
        onMutated={() => {
          void refresh();
          void refreshWorkflowRuns();
        }}
      />
    </div>
  );
}
