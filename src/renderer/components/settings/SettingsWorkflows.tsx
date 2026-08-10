/**
 * Workflow review UI (M4) — propose drafts, inspect step pipeline, enable/run.
 * Lightweight canvas: ordered stage rail (not a full graph editor).
 * OpenHuman-style per-flow run history + inspector drawer.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Check,
  ChevronRight,
  CirclePlay,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
  Zap,
} from 'lucide-react';
import type { CheckpointRun } from '../../../shared/orchestration';
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowStatus,
} from '../../../shared/workflows';
import { topologicalOrder } from '../../../shared/workflows';
import { WorkflowRunInspector } from '../workflows/WorkflowRunInspector';
import { WorkflowRunsList } from '../workflows/WorkflowRunsList';
import { useWorkflowRunsLiveRefresh } from '../workflows/useWorkflowRunsLiveRefresh';
import { SettingsContentSection } from './shared';

const NODE_META: Record<
  WorkflowNodeType,
  { label: string; icon: typeof Zap; tint: string; ring: string; blurb: string }
> = {
  trigger: {
    label: 'Trigger',
    icon: Zap,
    tint: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
    ring: 'ring-sky-500/35',
    blurb: 'When this automation starts',
  },
  agent: {
    label: 'Agent',
    icon: Sparkles,
    tint: 'bg-accent/12 text-accent',
    ring: 'ring-accent/40',
    blurb: 'York runs this prompt with tools',
  },
  tool: {
    label: 'Tool',
    icon: Workflow,
    tint: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
    ring: 'ring-violet-500/35',
    blurb: 'Direct tool invocation',
  },
  approval: {
    label: 'Approval',
    icon: ShieldCheck,
    tint: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
    ring: 'ring-amber-500/45',
    blurb: 'Always requires your explicit permission',
  },
  notify: {
    label: 'Notify',
    icon: Bell,
    tint: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    ring: 'ring-emerald-500/35',
    blurb: 'Signal when the run finishes',
  },
};

const STATUS_STYLES: Record<WorkflowStatus, string> = {
  draft: 'bg-surface-muted text-text-secondary ring-1 ring-border-muted',
  enabled: 'bg-accent/12 text-accent ring-1 ring-accent/25',
  disabled: 'bg-surface text-text-muted ring-1 ring-border',
};

function nodeSummary(node: WorkflowNode): string {
  if (node.type === 'trigger') {
    if (node.trigger === 'cron' && node.cron?.times?.length) {
      const days =
        node.cron.weekdays && node.cron.weekdays.length
          ? ` · days ${node.cron.weekdays.join(',')}`
          : '';
      return `${node.cron.times.join(', ')}${days}`;
    }
    if (node.trigger === 'channel') return node.channel || 'Channel event';
    return 'Manual run';
  }
  if (node.type === 'agent') return node.prompt?.trim() || 'Agent step';
  if (node.type === 'tool') return node.toolName || 'Tool';
  if (node.type === 'approval') return node.message || 'Requires approval';
  if (node.type === 'notify') return node.message || 'Notify';
  return (node as WorkflowNode).label || (node as WorkflowNode).id;
}

function statusLabel(status: WorkflowStatus): string {
  if (status === 'enabled') return 'Enabled';
  if (status === 'disabled') return 'Disabled';
  return 'Draft';
}

export function SettingsWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [proposeText, setProposeText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<CheckpointRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.workflows) return;
    setWorkflows(await window.electronAPI.workflows.list());
  }, []);

  const refreshRuns = useCallback(async () => {
    if (!selectedId || !window.electronAPI?.workflows?.listRuns) {
      setRuns([]);
      return;
    }
    setRunsLoading(true);
    try {
      setRuns(await window.electronAPI.workflows.listRuns(selectedId, 40));
    } finally {
      setRunsLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshRuns();
    setSelectedRunId(null);
  }, [refreshRuns]);

  useWorkflowRunsLiveRefresh(runs, refreshRuns);

  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) || null,
    [workflows, selectedId]
  );

  useEffect(() => {
    if (!selected) {
      setActiveNodeId(null);
      return;
    }
    const order = topologicalOrder(selected.graph);
    setActiveNodeId((prev) =>
      prev && selected.graph.nodes.some((n) => n.id === prev) ? prev : order[0] || null
    );
  }, [selected]);

  const propose = async () => {
    if (!proposeText.trim()) return;
    setBusy(true);
    try {
      const draft = await window.electronAPI.workflows.propose(proposeText.trim());
      setSelectedId(draft.id);
      setProposeText('');
      setStatus('Draft ready — review each step, then enable when it looks right.');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const setStatusFlag = async (statusValue: WorkflowStatus) => {
    if (!selected) return;
    setBusy(true);
    try {
      await window.electronAPI.workflows.update(selected.id, { status: statusValue });
      setStatus(
        statusValue === 'enabled'
          ? 'Workflow enabled. Manual runs and future triggers are live.'
          : statusValue === 'disabled'
            ? 'Workflow disabled.'
            : 'Saved as draft.'
      );
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.workflows.run(selected.id);
      setStatus(`Run started · ${result.runId.slice(0, 8)}… · ${result.status}`);
      setSelectedRunId(result.runId);
      await refreshRuns();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete “${selected.name}”? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await window.electronAPI.workflows.delete(selected.id);
      setSelectedId(null);
      setStatus('Workflow deleted.');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsContentSection
        title="Visual workflows"
        description="Turn a plain request into a reviewable automation. Approval steps always stop for you. Run history updates live while a run is active."
      >
        {/* Composer */}
        <div className="relative overflow-hidden rounded-2xl border border-border-muted bg-gradient-to-br from-accent/[0.07] via-background to-background-secondary/80 p-4 sm:p-5">
          <div
            className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-accent/10 blur-2xl"
            aria-hidden
          />
          <div className="relative space-y-3">
            <div className="flex items-center gap-2 text-text-primary">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-semibold tracking-tight">Propose an automation</p>
                <p className="text-[11px] leading-4 text-text-muted">
                  Example: every weekday at 9am, brief me on Hub leave and calendar.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <textarea
                value={proposeText}
                onChange={(e) => setProposeText(e.target.value)}
                rows={2}
                placeholder="Describe what to automate…"
                className="min-h-[3.25rem] flex-1 resize-y rounded-xl border border-border bg-background/90 px-3.5 py-2.5 text-sm leading-5 text-text-primary shadow-soft placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void propose();
                  }
                }}
              />
              <button
                type="button"
                disabled={busy || !proposeText.trim()}
                onClick={() => void propose()}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-soft transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-[7.5rem]"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Propose
              </button>
            </div>
            <p className="text-[11px] text-text-muted">⌘/Ctrl + Enter to propose</p>
          </div>
        </div>

        {/* Workspace */}
        <div className="grid min-h-[28rem] gap-3 lg:grid-cols-[minmax(200px,240px)_1fr]">
          {/* Library */}
          <aside className="flex max-h-[32rem] flex-col overflow-hidden rounded-2xl border border-border-muted bg-background-secondary/50">
            <div className="flex items-center justify-between border-b border-border-muted px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                Library
              </p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg p-1.5 text-text-muted transition hover:bg-surface-hover hover:text-text-primary"
                title="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto p-2">
              {workflows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
                  <Workflow className="h-7 w-7 text-text-muted/70" />
                  <p className="text-xs leading-5 text-text-muted">
                    No workflows yet. Propose one above to get a draft graph.
                  </p>
                </div>
              ) : (
                workflows.map((w) => {
                  const isSelected = selectedId === w.id;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => setSelectedId(w.id)}
                      className={`group w-full rounded-xl px-3 py-2.5 text-left transition ${
                        isSelected
                          ? 'bg-accent/10 ring-1 ring-accent/30'
                          : 'hover:bg-surface-hover'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className={`truncate text-sm font-medium ${
                            isSelected ? 'text-text-primary' : 'text-text-secondary'
                          }`}
                        >
                          {w.name}
                        </p>
                        <ChevronRight
                          className={`mt-0.5 h-3.5 w-3.5 shrink-0 transition ${
                            isSelected
                              ? 'text-accent opacity-100'
                              : 'text-text-muted opacity-0 group-hover:opacity-100'
                          }`}
                        />
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <span
                          className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLES[w.status]}`}
                        >
                          {statusLabel(w.status)}
                        </span>
                        <span className="text-[10px] text-text-muted">
                          {w.graph.nodes.length} steps
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Detail */}
          <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border-muted bg-background">
            {!selected ? (
              <EmptyDetail />
            ) : (
              <>
                <header className="border-b border-border-muted px-4 py-3.5 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="truncate text-base font-semibold tracking-tight text-text-primary">
                          {selected.name}
                        </h4>
                        <span
                          className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[selected.status]}`}
                        >
                          {statusLabel(selected.status)}
                        </span>
                      </div>
                      {selected.description ? (
                        <p className="line-clamp-2 text-xs leading-5 text-text-muted">
                          {selected.description}
                        </p>
                      ) : null}
                      <p className="text-[11px] text-text-muted">
                        Updated {new Date(selected.updatedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {selected.status !== 'enabled' ? (
                        <ActionButton
                          onClick={() => void setStatusFlag('enabled')}
                          disabled={busy}
                          variant="primary"
                          icon={Check}
                          label="Enable"
                        />
                      ) : (
                        <ActionButton
                          onClick={() => void setStatusFlag('disabled')}
                          disabled={busy}
                          variant="ghost"
                          icon={Pause}
                          label="Disable"
                        />
                      )}
                      <ActionButton
                        onClick={() => void run()}
                        disabled={busy}
                        variant="secondary"
                        icon={Play}
                        label="Run now"
                      />
                      <ActionButton
                        onClick={() => void remove()}
                        disabled={busy}
                        variant="danger"
                        icon={Trash2}
                        label="Delete"
                      />
                    </div>
                  </div>
                </header>

                <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
                  <WorkflowPipeline
                    nodes={selected.graph.nodes}
                    edges={selected.graph.edges}
                    activeNodeId={activeNodeId}
                    onSelectNode={setActiveNodeId}
                  />
                  <NodeInspector
                    node={
                      selected.graph.nodes.find((n) => n.id === activeNodeId) ||
                      selected.graph.nodes[0] ||
                      null
                    }
                  />

                  {/* Per-flow run history (OpenHuman FlowRunsSidebar) */}
                  <div className="rounded-2xl border border-border-muted bg-background-secondary/40 p-3 sm:p-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                        Runs
                      </p>
                      <button
                        type="button"
                        onClick={() => void refreshRuns()}
                        disabled={runsLoading}
                        className="rounded-lg p-1.5 text-text-muted transition hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
                        title="Refresh runs"
                        aria-label="Refresh runs"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${runsLoading ? 'animate-spin' : ''}`}
                        />
                      </button>
                    </div>
                    <WorkflowRunsList
                      runs={runs}
                      selectedRunId={selectedRunId}
                      onSelect={setSelectedRunId}
                      loading={runsLoading}
                      emptyLabel="No runs yet. Use Run now to start one."
                    />
                  </div>
                </div>
              </>
            )}
          </section>
        </div>

        {status ? (
          <p
            className="rounded-xl border border-border-muted bg-surface-muted/60 px-3 py-2 text-xs text-text-secondary"
            role="status"
          >
            {status}
          </p>
        ) : null}
      </SettingsContentSection>

      <WorkflowRunInspector
        runId={selectedRunId}
        onClose={() => setSelectedRunId(null)}
        onMutated={() => void refreshRuns()}
      />
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  variant,
  icon: Icon,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  variant: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon: typeof Play;
  label: string;
}) {
  const styles =
    variant === 'primary'
      ? 'bg-accent text-white hover:opacity-95'
      : variant === 'secondary'
        ? 'border border-border bg-surface text-text-primary hover:bg-surface-hover'
        : variant === 'danger'
          ? 'border border-transparent text-error hover:bg-error/10'
          : 'border border-border text-text-secondary hover:bg-surface-hover';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function EmptyDetail() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        <CirclePlay className="h-7 w-7" />
      </div>
      <div className="max-w-xs space-y-1">
        <p className="text-sm font-medium text-text-primary">Select a workflow</p>
        <p className="text-xs leading-5 text-text-muted">
          Review the step pipeline, inspect approval gates, then enable when you trust the graph.
        </p>
      </div>
    </div>
  );
}

function WorkflowPipeline({
  nodes,
  edges,
  activeNodeId,
  onSelectNode,
}: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  activeNodeId: string | null;
  onSelectNode: (id: string) => void;
}) {
  const order = useMemo(() => topologicalOrder({ version: 1, nodes, edges }), [nodes, edges]);
  const orderedNodes = order
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowNode => Boolean(n));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Pipeline
        </p>
        <p className="text-[11px] text-text-muted">{orderedNodes.length} stages · left to right</p>
      </div>

      <div className="workflow-pipeline relative overflow-x-auto pb-1">
        <ol className="flex min-w-min items-stretch gap-0 px-0.5 py-1">
          {orderedNodes.map((node, index) => {
            const meta = NODE_META[node.type];
            const Icon = meta.icon;
            const isActive = activeNodeId === node.id;
            const isLast = index === orderedNodes.length - 1;
            const summary = nodeSummary(node);

            return (
              <li key={node.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => onSelectNode(node.id)}
                  className={`group relative flex w-[9.5rem] shrink-0 flex-col rounded-2xl border bg-background px-3 py-3 text-left transition duration-200 ${
                    isActive
                      ? `border-transparent shadow-soft ring-2 ${meta.ring}`
                      : 'border-border-muted hover:border-border hover:shadow-soft'
                  } ${node.type === 'approval' && !isActive ? 'border-amber-500/35' : ''}`}
                >
                  <span
                    className={`mb-2 inline-flex h-8 w-8 items-center justify-center rounded-xl ${meta.tint}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                    {meta.label}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-sm font-medium leading-snug text-text-primary">
                    {node.label || meta.label}
                  </span>
                  <span className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-text-muted">
                    {summary}
                  </span>
                  {node.type === 'approval' ? (
                    <span className="mt-2 inline-flex w-fit items-center gap-1 rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
                      <ShieldCheck className="h-3 w-3" />
                      Gated
                    </span>
                  ) : null}
                </button>

                {!isLast ? (
                  <div
                    className="mx-1.5 flex w-7 shrink-0 flex-col items-center justify-center"
                    aria-hidden
                  >
                    <div className="h-px w-full bg-gradient-to-r from-border via-accent/40 to-border" />
                    <ChevronRight className="-mt-1.5 h-3.5 w-3.5 text-text-muted" />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>

      <p className="text-[11px] leading-4 text-text-muted">
        Approval stages never auto-skip — they use the same permission flow as chat tools.
      </p>
    </div>
  );
}

function NodeInspector({ node }: { node: WorkflowNode | null }) {
  if (!node) return null;
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  const summary = nodeSummary(node);

  return (
    <div className="rounded-2xl border border-border-muted bg-background-secondary/40 p-4">
      <div className="flex items-start gap-3">
        <span
          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${meta.tint}`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-text-primary">{node.label || meta.label}</p>
            <span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
              {meta.label}
            </span>
          </div>
          <p className="text-xs text-text-muted">{meta.blurb}</p>
        </div>
      </div>
      <div className="mt-3 rounded-xl border border-border-muted/80 bg-background px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
          Detail
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-text-secondary">{summary}</p>
      </div>
      {node.type === 'approval' ? (
        <p className="mt-2 text-[11px] leading-4 text-amber-800/90 dark:text-amber-200/90">
          When this step runs, York pauses and asks you to allow or deny before any later stages.
        </p>
      ) : null}
    </div>
  );
}
