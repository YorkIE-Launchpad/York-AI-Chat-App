/**
 * Single workflow-run inspector drawer (OpenHuman FlowRunInspectorDrawer).
 * Polls getRun every 2s while non-terminal; shows step timeline + resume/cancel.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { CheckpointRun } from '../../../shared/orchestration';
import {
  getWorkflowRunSteps,
  isWorkflowRunTerminal,
  type WorkflowRunStep,
} from '../../../shared/workflows';
import {
  relativeTime,
  runDisplayStatus,
  runStatusDotClass,
  runStatusLabel,
  runStatusPillClass,
  stepStatusDotClass,
} from './WorkflowRunStatus';

export interface WorkflowRunInspectorProps {
  runId: string | null;
  onClose: () => void;
  /** Called after resume/cancel so parent lists can refresh. */
  onMutated?: () => void;
}

function formatTs(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function WorkflowRunInspector({ runId, onClose, onMutated }: WorkflowRunInspectorProps) {
  const [run, setRun] = useState<CheckpointRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!runId || !window.electronAPI?.workflows?.getRun) return;
    try {
      const next = await window.electronAPI.workflows.getRun(runId);
      setRun(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [runId, load]);

  useEffect(() => {
    if (!runId || !run || isWorkflowRunTerminal(run.status)) return undefined;
    const timer = window.setInterval(() => {
      void load();
    }, 2000);
    const unsub = window.electronAPI?.workflows?.onRunProgress?.((event) => {
      if (event.runId === runId) void load();
    });
    return () => {
      window.clearInterval(timer);
      unsub?.();
    };
  }, [runId, run?.status, load]);

  useEffect(() => {
    if (!runId) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runId, onClose]);

  if (!runId) return null;

  const display = run ? runDisplayStatus(run.status) : 'running';
  const steps: WorkflowRunStep[] = run ? getWorkflowRunSteps(run.payload) : [];
  const approvalMessage =
    run && typeof run.payload.approvalMessage === 'string'
      ? run.payload.approvalMessage
      : null;
  const startedAt = formatTs(run?.createdAt);
  const finishedAt = formatTs(run?.completedAt ?? undefined);
  const nonTerminal = run && !isWorkflowRunTerminal(run.status);

  const resume = async () => {
    if (!run) return;
    setBusy(true);
    try {
      await window.electronAPI.checkpoints.resume(run.id);
      await load();
      onMutated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    setBusy(true);
    try {
      await window.electronAPI.checkpoints.cancel(run.id);
      await load();
      onMutated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close run inspector"
        onClick={onClose}
      />
      <aside
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-border-muted bg-background shadow-soft"
        role="dialog"
        aria-label="Workflow run details"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-muted px-4 py-3.5">
          <div className="min-w-0 space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Run details
            </p>
            {run ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${runStatusDotClass(display)}`} />
                <span
                  className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium ${runStatusPillClass(display)}`}
                >
                  {runStatusLabel(display)}
                </span>
                <span
                  className="font-mono text-[11px] text-text-muted"
                  title={run.id}
                >
                  {run.id.slice(0, 8)}
                </span>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {loading && !run ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : null}

          {error ? (
            <p className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
              {error}
            </p>
          ) : null}

          {run ? (
            <>
              <div className="space-y-1 text-xs text-text-secondary">
                {startedAt ? (
                  <p>
                    <span className="text-text-muted">Started:</span> {startedAt}
                    <span className="text-text-muted"> · {relativeTime(run.createdAt)}</span>
                  </p>
                ) : null}
                {finishedAt ? (
                  <p>
                    <span className="text-text-muted">Finished:</span> {finishedAt}
                  </p>
                ) : nonTerminal ? (
                  <p className="text-accent">Still running…</p>
                ) : null}
                {run.title ? (
                  <p>
                    <span className="text-text-muted">Workflow:</span> {run.title}
                  </p>
                ) : null}
              </div>

              {run.error ? (
                <div className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
                  <p className="font-medium">Error</p>
                  <p className="mt-1 whitespace-pre-wrap">{run.error}</p>
                </div>
              ) : null}

              {run.status === 'paused_for_approval' ? (
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-3 text-xs text-amber-900 dark:text-amber-100">
                  <p className="font-semibold">Needs approval</p>
                  <p className="mt-1 leading-5 text-amber-800/90 dark:text-amber-200/90">
                    {approvalMessage || 'This run is waiting for you to allow a gated step.'}
                  </p>
                  <p className="mt-2 text-[11px] text-text-muted">
                    Use the permission dialog if open, or Resume after approving.
                  </p>
                </div>
              ) : null}

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                  Steps
                </p>
                {steps.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    No step timeline recorded for this run (older runs may lack details).
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {steps.map((step, index) => {
                      const expanded = expandedStepId === step.nodeId;
                      return (
                        <li
                          key={step.nodeId}
                          className="rounded-xl border border-border-muted bg-background-secondary/40 px-3 py-2.5"
                        >
                          <div className="flex items-start gap-2.5">
                            <span
                              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${stepStatusDotClass(step.status)}`}
                              aria-hidden
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
                                  {index + 1}. {step.type}
                                </span>
                                <span className="truncate text-sm font-medium text-text-primary">
                                  {step.label}
                                </span>
                              </div>
                              {step.summary ? (
                                <p
                                  className={`mt-0.5 text-xs leading-5 ${
                                    step.status === 'failed'
                                      ? 'text-error'
                                      : step.status === 'success'
                                        ? 'text-text-secondary'
                                        : 'italic text-text-muted'
                                  }`}
                                >
                                  {step.status === 'success' ? '✓ ' : step.status === 'failed' ? '✗ ' : ''}
                                  {step.summary}
                                </p>
                              ) : null}
                              {step.output != null ? (
                                <button
                                  type="button"
                                  className="mt-1 text-[11px] text-accent hover:underline"
                                  onClick={() =>
                                    setExpandedStepId(expanded ? null : step.nodeId)
                                  }
                                >
                                  {expanded ? 'Hide raw output' : 'Show raw output'}
                                </button>
                              ) : null}
                              {expanded && step.output != null ? (
                                <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-background px-2 py-1.5 font-mono text-[10px] leading-4 text-text-secondary">
                                  {typeof step.output === 'string'
                                    ? step.output
                                    : JSON.stringify(step.output, null, 2)}
                                </pre>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </>
          ) : null}
        </div>

        {run && nonTerminal ? (
          <footer className="flex gap-2 border-t border-border-muted px-4 py-3">
            {(run.status === 'paused_for_approval' ||
              run.status === 'running' ||
              run.status === 'stuck') && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void resume()}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Resume
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void cancel()}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50"
            >
              Cancel
            </button>
          </footer>
        ) : null}
      </aside>
    </div>
  );
}
