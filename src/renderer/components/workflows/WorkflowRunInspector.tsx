/**
 * Single workflow-run inspector drawer (OpenHuman FlowRunInspectorDrawer).
 * Polls getRun every 2s while non-terminal; shows step timeline + resume/cancel.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, Loader2, MessageSquare, X } from 'lucide-react';
import type { CheckpointRun } from '../../../shared/orchestration';
import type { WorkflowInputField } from '../../../shared/workflows';
import {
  getWorkflowRunSteps,
  isWorkflowRunTerminal,
  type WorkflowRunStep,
} from '../../../shared/workflows';
import { sessionIdsFromWorkflowRun } from '../../../shared/workflow-graph-edit';
import { activeDivisionFromSession } from '../../../shared/workspace-division';
import { useAppStore } from '../../store';
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

function stepSessionId(step: WorkflowRunStep): string | null {
  if (step.output && typeof step.output === 'object' && step.output !== null) {
    const sid = (step.output as { sessionId?: unknown }).sessionId;
    if (typeof sid === 'string' && sid.trim()) return sid.trim();
  }
  return null;
}

function readInputFields(payload: CheckpointRun['payload']): WorkflowInputField[] {
  const raw = payload.inputFields;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is WorkflowInputField =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as WorkflowInputField).key === 'string' &&
      typeof (f as WorkflowInputField).label === 'string' &&
      ((f as WorkflowInputField).kind === 'text' ||
        (f as WorkflowInputField).kind === 'choice')
  );
}

export function WorkflowRunInspector({ runId, onClose, onMutated }: WorkflowRunInspectorProps) {
  const { t } = useTranslation();
  const [run, setRun] = useState<CheckpointRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [chatHint, setChatHint] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [choiceSelections, setChoiceSelections] = useState<Record<string, string[]>>({});
  const [inputError, setInputError] = useState<string | null>(null);

  const sessions = useAppStore((s) => s.sessions);
  const pendingQuestionsBySessionId = useAppStore((s) => s.pendingQuestionsBySessionId);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setActiveDivision = useAppStore((s) => s.setActiveDivision);

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
    const unsubProgress = window.electronAPI?.workflows?.onRunProgress?.((event) => {
      if (event.runId === runId) void load();
    });
    const unsubInput = window.electronAPI?.workflows?.onInputRequest?.((event) => {
      if (event.runId === runId) void load();
    });
    return () => {
      window.clearInterval(timer);
      unsubProgress?.();
      unsubInput?.();
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

  const sessionIds = useMemo(
    () => (run ? sessionIdsFromWorkflowRun(run.payload) : []),
    [run]
  );
  const primarySessionId = sessionIds[sessionIds.length - 1] || null;

  const sessionAwaitingQuestion = useMemo(() => {
    for (const id of [...sessionIds].reverse()) {
      if (pendingQuestionsBySessionId[id]) return id;
    }
    return null;
  }, [sessionIds, pendingQuestionsBySessionId]);

  const inputFields = useMemo(
    () => (run ? readInputFields(run.payload) : []),
    [run]
  );
  const inputNodeId =
    run && typeof run.payload.inputNodeId === 'string' ? run.payload.inputNodeId : null;
  const inputPrompt =
    run && typeof run.payload.inputPrompt === 'string' ? run.payload.inputPrompt : null;

  useEffect(() => {
    if (run?.status !== 'paused_for_input') {
      setAnswers({});
      setChoiceSelections({});
      setInputError(null);
      return;
    }
    const nextAnswers: Record<string, string> = {};
    const nextChoices: Record<string, string[]> = {};
    for (const field of inputFields) {
      if (field.kind === 'choice') {
        nextChoices[field.key] = [];
      } else {
        nextAnswers[field.key] = '';
      }
    }
    setAnswers(nextAnswers);
    setChoiceSelections(nextChoices);
    setInputError(null);
  }, [run?.status, run?.id, inputFields]);

  const openChat = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        setChatHint('Chat still starting… try again in a moment.');
        return;
      }
      setChatHint(null);
      setActiveDivision(activeDivisionFromSession(session));
      setActiveSession(sessionId);
      onClose();
    },
    [sessions, setActiveDivision, setActiveSession, onClose]
  );

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

  const buildSubmittedAnswers = (): Record<string, string> | null => {
    const result: Record<string, string> = {};
    for (const field of inputFields) {
      const required = field.required !== false;
      if (field.kind === 'choice') {
        const selected = choiceSelections[field.key] || [];
        if (required && selected.length === 0) {
          setInputError(`Select an option for “${field.label}”.`);
          return null;
        }
        result[field.key] = selected.join(', ');
      } else {
        const value = (answers[field.key] || '').trim();
        if (required && !value) {
          setInputError(`Fill in “${field.label}”.`);
          return null;
        }
        result[field.key] = value;
      }
    }
    setInputError(null);
    return result;
  };

  const submitInput = async () => {
    if (!run || !inputNodeId) return;
    const payloadAnswers = buildSubmittedAnswers();
    if (!payloadAnswers) return;
    setBusy(true);
    try {
      await window.electronAPI.workflows.submitInput({
        runId: run.id,
        nodeId: inputNodeId,
        answers: payloadAnswers,
      });
      await load();
      onMutated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelInput = async () => {
    if (!run || !inputNodeId) return;
    setBusy(true);
    try {
      await window.electronAPI.workflows.cancelInput({
        runId: run.id,
        nodeId: inputNodeId,
      });
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
                <span className="font-mono text-[11px] text-text-muted" title={run.id}>
                  {run.id.slice(0, 8)}
                </span>
              </div>
            ) : null}
            {primarySessionId ? (
              <button
                type="button"
                onClick={() => openChat(primarySessionId)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-hover"
              >
                <MessageSquare className="h-3 w-3" />
                Open chat
              </button>
            ) : null}
            {chatHint ? <p className="text-[11px] text-text-muted">{chatHint}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary"
            title={t('common.close')}
            aria-label={t('common.close')}
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

              {sessionAwaitingQuestion ? (
                <div className="rounded-xl border border-accent/35 bg-accent/10 px-3 py-3 text-xs text-text-primary">
                  <p className="inline-flex items-center gap-1.5 font-semibold text-accent">
                    <HelpCircle className="h-3.5 w-3.5" />
                    Agent needs your answer
                  </p>
                  <p className="mt-1 leading-5 text-text-secondary">
                    An agent step asked a clarifying question in chat. Answer there to continue
                    this step.
                  </p>
                  <button
                    type="button"
                    onClick={() => openChat(sessionAwaitingQuestion)}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-white"
                  >
                    <MessageSquare className="h-3 w-3" />
                    Answer in chat
                  </button>
                </div>
              ) : null}

              {run.status === 'paused_for_approval' ? (
                <div className="rounded-xl border border-accent/35 bg-accent/10 px-3 py-3 text-xs text-text-primary">
                  <p className="font-semibold text-accent">Needs approval</p>
                  <p className="mt-1 leading-5 text-text-secondary">
                    {approvalMessage || 'This run is waiting for you to allow a gated step.'}
                  </p>
                  <p className="mt-2 text-[11px] text-text-muted">
                    Use the permission dialog if open, or Resume after approving.
                  </p>
                </div>
              ) : null}

              {run.status === 'paused_for_input' ? (
                <div className="rounded-xl border border-accent/35 bg-accent/10 px-3 py-3 text-xs text-text-primary">
                  <p className="font-semibold text-accent">Needs input</p>
                  <p className="mt-1 leading-5 text-text-secondary">
                    {inputPrompt || 'Provide the information needed to continue this workflow.'}
                  </p>
                  <div className="mt-3 space-y-3">
                    {inputFields.map((field) => (
                      <div key={field.key} className="space-y-1.5">
                        <p className="text-[11px] font-medium text-text-primary">
                          {field.label}
                          {field.required === false ? (
                            <span className="ml-1 font-normal text-text-muted">(optional)</span>
                          ) : null}
                        </p>
                        {field.kind === 'choice' ? (
                          <div className="flex flex-wrap gap-1.5">
                            {(field.options || []).map((option) => {
                              const selected = (choiceSelections[field.key] || []).includes(
                                option
                              );
                              return (
                                <button
                                  key={option}
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setChoiceSelections((prev) => {
                                      const current = prev[field.key] || [];
                                      if (field.multiSelect) {
                                        return {
                                          ...prev,
                                          [field.key]: selected
                                            ? current.filter((o) => o !== option)
                                            : [...current, option],
                                        };
                                      }
                                      return { ...prev, [field.key]: [option] };
                                    });
                                    setInputError(null);
                                  }}
                                  className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
                                    selected
                                      ? 'border-accent bg-accent text-white'
                                      : 'border-border bg-background text-text-secondary hover:bg-surface-hover'
                                  } disabled:opacity-50`}
                                >
                                  {option}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <input
                            type="text"
                            value={answers[field.key] || ''}
                            disabled={busy}
                            placeholder={field.placeholder || ''}
                            onChange={(e) => {
                              const value = e.target.value;
                              setAnswers((prev) => ({ ...prev, [field.key]: value }));
                              setInputError(null);
                            }}
                            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-text-primary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  {inputError ? (
                    <p className="mt-2 text-[11px] text-error">{inputError}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || !inputNodeId}
                      onClick={() => void submitInput()}
                      className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
                    >
                      Submit answers
                    </button>
                    <button
                      type="button"
                      disabled={busy || !inputNodeId}
                      onClick={() => void cancelInput()}
                      className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50"
                    >
                      Cancel input
                    </button>
                  </div>
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
                      const sessionId = stepSessionId(step);
                      const stepHasPendingQuestion =
                        sessionId != null && Boolean(pendingQuestionsBySessionId[sessionId]);
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
                                {sessionId ? (
                                  <button
                                    type="button"
                                    onClick={() => openChat(sessionId)}
                                    className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
                                  >
                                    <MessageSquare className="h-3 w-3" />
                                    {stepHasPendingQuestion ? 'Answer' : 'Open'}
                                  </button>
                                ) : null}
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
                                  {step.status === 'success'
                                    ? '✓ '
                                    : step.status === 'failed'
                                      ? '✗ '
                                      : ''}
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
