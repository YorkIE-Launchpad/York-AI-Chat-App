/**
 * Workflow review body — propose drafts, graph canvas, run history.
 * Used by WorkflowsPage (first-class sidebar surface).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Check,
  CirclePlay,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
  Zap,
} from 'lucide-react';
import type { BackendModelInfo } from '../../../shared/backend-config';
import type { CheckpointRun } from '../../../shared/orchestration';
import type {
  WorkflowBinding,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRunStep,
  WorkflowStatus,
} from '../../../shared/workflows';
import {
  getWorkflowRunSteps,
  topologicalOrder,
  workflowWorkspaceLabel,
} from '../../../shared/workflows';
import {
  insertAgentAfter,
  removeAgentNode,
  removeNode,
  splitAgentPrompt,
  updateNodeFields,
} from '../../../shared/workflow-graph-edit';
import { ensureGraphPositions } from '../../../shared/workflow-graph-xyflow';
import {
  activeDivisionFromUnifiedProject,
  sessionFieldsFromActiveDivision,
  type PersonalFolder,
} from '../../../shared/workspace-division';
import type { UnifiedCompanyProject } from '../../../shared/unified-company-projects';
import { useAppStore } from '../../store';
import { WorkflowGraphCanvas } from './canvas/WorkflowGraphCanvas';
import { WorkflowRunInspector } from './WorkflowRunInspector';
import { WorkflowRunsList } from './WorkflowRunsList';
import { useWorkflowRunsLiveRefresh } from './useWorkflowRunsLiveRefresh';
import { rememberRecentProject } from '../../utils/recent-projects';

const ACCENT_TINT = 'bg-accent/12 text-accent';
const ACCENT_RING = 'ring-accent/40';

const NODE_META: Record<
  WorkflowNodeType,
  { label: string; icon: typeof Zap; tint: string; ring: string; blurb: string }
> = {
  trigger: {
    label: 'Trigger',
    icon: Zap,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'When this automation starts',
  },
  agent: {
    label: 'Agent',
    icon: Sparkles,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'York runs this prompt with tools; later agents receive prior results',
  },
  tool: {
    label: 'Tool',
    icon: Workflow,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'Direct tool invocation',
  },
  approval: {
    label: 'Approval',
    icon: ShieldCheck,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'Always requires your explicit permission',
  },
  notify: {
    label: 'Notify',
    icon: Bell,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
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

function shortModelLabel(modelId: string): string {
  const parts = modelId.split('/');
  return parts[parts.length - 1] || modelId;
}

export function WorkflowsWorkspace() {
  const activeDivision = useAppStore((s) => s.activeDivision);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  /** Local editable draft graph (Save/Discard). */
  const [draftGraph, setDraftGraph] = useState<WorkflowGraph | null>(null);
  const [graphDirty, setGraphDirty] = useState(false);
  const [proposeText, setProposeText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<CheckpointRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [projects, setProjects] = useState<UnifiedCompanyProject[]>([]);
  const [folders, setFolders] = useState<PersonalFolder[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

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

  const loadWorkspaceOptions = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const api = window.electronAPI?.projects;
      if (api?.listUnified) {
        const result = await api.listUnified();
        setProjects(result.projects || []);
      } else {
        setProjects([]);
      }
      const foldersApi = window.electronAPI?.folders;
      if (foldersApi?.list) {
        const result = await foldersApi.list();
        setFolders(result.folders || []);
      } else {
        setFolders([]);
      }
    } catch {
      setProjects([]);
      setFolders([]);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadWorkspaceOptions();
  }, [refresh, loadWorkspaceOptions]);

  useEffect(() => {
    void refreshRuns();
    setSelectedRunId(null);
  }, [refreshRuns]);

  useWorkflowRunsLiveRefresh(runs, refreshRuns);

  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) || null,
    [workflows, selectedId]
  );

  const selectedRunSteps: WorkflowRunStep[] = useMemo(() => {
    if (!selectedRunId) return [];
    const run = runs.find((r) => r.id === selectedRunId);
    return run ? getWorkflowRunSteps(run.payload) : [];
  }, [runs, selectedRunId]);

  const activeGraph = draftGraph ?? selected?.graph ?? null;

  useEffect(() => {
    if (!selected) {
      setActiveNodeId(null);
      setEditName('');
      setDraftGraph(null);
      setGraphDirty(false);
      return;
    }
    setEditName(selected.name);
    // Reset draft only when switching workflows or after successful save refresh (not dirty).
    setDraftGraph((prev) => {
      if (graphDirty && prev) return prev;
      return ensureGraphPositions(selected.graph);
    });
    if (!graphDirty) {
      const order = topologicalOrder(selected.graph);
      setActiveNodeId((prev) =>
        prev && selected.graph.nodes.some((n) => n.id === prev) ? prev : order[0] || null
      );
    }
  }, [selected, graphDirty]);

  const selectWorkflow = (id: string | null) => {
    if (id === selectedId) return;
    if (graphDirty) {
      const ok = window.confirm('Discard unsaved graph changes?');
      if (!ok) return;
    }
    setGraphDirty(false);
    setDraftGraph(null);
    setSelectedId(id);
  };

  const propose = async () => {
    if (!proposeText.trim()) return;
    setBusy(true);
    try {
      const binding = sessionFieldsFromActiveDivision(activeDivision) as Partial<WorkflowBinding>;
      const draft = await window.electronAPI.workflows.propose(proposeText.trim(), binding);
      setGraphDirty(false);
      setDraftGraph(null);
      setSelectedId(draft.id);
      setProposeText('');
      const nodeKinds = draft.graph.nodes.map((n) =>
        n.type === 'trigger' ? `trigger:${n.trigger}` : n.type
      );
      setStatus(
        `Draft ready · ${draft.name} · ${workflowWorkspaceLabel(draft)} · ${nodeKinds.join(' → ')}. Review graph, then enable when right.`
      );
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    if (!selected || !editName.trim() || editName.trim() === selected.name) return;
    setBusy(true);
    try {
      await window.electronAPI.workflows.update(selected.id, { name: editName.trim() });
      setStatus('Title updated.');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const updateBinding = async (binding: Partial<WorkflowBinding>) => {
    if (!selected) return;
    setBusy(true);
    try {
      await window.electronAPI.workflows.update(selected.id, binding);
      setStatus(
        `Workspace set to ${workflowWorkspaceLabel({ ...selected, ...binding } as WorkflowDefinition)}. Runs will appear there.`
      );
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
      const cron =
        selected.graph.nodes.find((n) => n.type === 'trigger' && n.trigger === 'cron') || null;
      setStatus(
        statusValue === 'enabled'
          ? cron
            ? `Workflow enabled in ${workflowWorkspaceLabel(selected)}. Cron armed as schedule.`
            : `Workflow enabled. Runs create chats in ${workflowWorkspaceLabel(selected)}.`
          : statusValue === 'disabled'
            ? 'Workflow disabled; linked schedule removed if any.'
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
      setStatus(
        `Run started · ${result.runId.slice(0, 8)}… · chats in ${workflowWorkspaceLabel(selected)}`
      );
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
      setDraftGraph(null);
      setGraphDirty(false);
      setStatus('Workflow deleted.');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const applyDraftGraph = (graph: WorkflowGraph, nextActiveId?: string | null) => {
    setDraftGraph(ensureGraphPositions(graph));
    setGraphDirty(true);
    if (nextActiveId !== undefined) {
      if (nextActiveId) setActiveNodeId(nextActiveId);
    }
  };

  const discardGraph = () => {
    if (!selected) return;
    setDraftGraph(ensureGraphPositions(selected.graph));
    setGraphDirty(false);
    setStatus('Graph changes discarded.');
    const order = topologicalOrder(selected.graph);
    setActiveNodeId((prev) =>
      prev && selected.graph.nodes.some((n) => n.id === prev) ? prev : order[0] || null
    );
  };

  const saveGraph = async (graph?: WorkflowGraph, toast?: string) => {
    if (!selected) return;
    const toSave = graph ?? draftGraph;
    if (!toSave) return;
    setBusy(true);
    try {
      await window.electronAPI.workflows.update(selected.id, { graph: toSave });
      setDraftGraph(ensureGraphPositions(toSave));
      setGraphDirty(false);
      setStatus(toast || 'Graph saved.');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const mutateGraph = (
    mutator: (graph: WorkflowGraph) => WorkflowGraph,
    toast?: string,
    nextActiveId?: string | null
  ) => {
    if (!selected || !activeGraph) return;
    try {
      const next = mutator(activeGraph);
      applyDraftGraph(next, nextActiveId);
      if (toast) setStatus(toast);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-6">
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
                  Drafts inherit your current workspace. Example: every weekday at 9am, brief me
                  on Hub leave and calendar.
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
                      onClick={() => selectWorkflow(w.id)}
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
                        <span
                          className={`mt-0.5 text-[10px] font-medium ${
                            isSelected ? 'text-accent opacity-100' : 'text-text-muted opacity-0 group-hover:opacity-100'
                          }`}
                        >
                          Open
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <span
                          className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLES[w.status]}`}
                        >
                          {statusLabel(w.status)}
                        </span>
                        <span className="truncate text-[10px] text-text-muted">
                          {workflowWorkspaceLabel(w)} · {w.graph.nodes.length} steps
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
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={() => void saveName()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void saveName();
                            }
                          }}
                          disabled={busy}
                          className="min-w-0 max-w-full flex-1 truncate rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold tracking-tight text-text-primary hover:border-border-muted focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
                          aria-label="Workflow title"
                        />
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
                      <WorkflowWorkspaceBinder
                        workflow={selected}
                        projects={projects}
                        folders={folders}
                        loading={projectsLoading}
                        disabled={busy}
                        onChange={(binding) => {
                          if (binding.division === 'project' && binding.hubProjectId) {
                            const project = projects.find(
                              (p) =>
                                p.hubProjectId === binding.hubProjectId ||
                                (binding.launchpadProjectId != null &&
                                  p.launchpadProjectId === binding.launchpadProjectId)
                            );
                            if (project) rememberRecentProject(project);
                          }
                          void updateBinding(binding);
                        }}
                        onRefreshOptions={() => void loadWorkspaceOptions()}
                      />
                      <p className="text-[11px] text-text-muted">
                        Agent step chats open in this workspace. Updated{' '}
                        {new Date(selected.updatedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {graphDirty ? (
                        <>
                          <ActionButton
                            onClick={() => void saveGraph(undefined, 'Graph saved.')}
                            disabled={busy}
                            variant="primary"
                            icon={Save}
                            label="Save graph"
                          />
                          <ActionButton
                            onClick={discardGraph}
                            disabled={busy}
                            variant="ghost"
                            icon={RotateCcw}
                            label="Discard"
                          />
                        </>
                      ) : null}
                      {selected.status !== 'enabled' ? (
                        <ActionButton
                          onClick={() => void setStatusFlag('enabled')}
                          disabled={busy || graphDirty}
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
                        disabled={busy || graphDirty}
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
                  {activeGraph ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                          Graph
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {activeGraph.nodes.length} nodes · {activeGraph.edges.length} edges
                          {graphDirty ? ' · unsaved' : ''}
                        </p>
                      </div>
                      <WorkflowGraphCanvas
                        graph={activeGraph}
                        selectedNodeId={activeNodeId}
                        runSteps={selectedRunSteps}
                        editable
                        busy={busy}
                        onSelectNode={setActiveNodeId}
                        onGraphChange={(g) => applyDraftGraph(g)}
                        onError={(message) => setStatus(message)}
                      />
                      <p className="text-[11px] leading-4 text-text-muted">
                        Drag nodes, connect handles, or use the palette. Save before enable or run.
                        Approval stages never auto-skip.
                      </p>
                    </div>
                  ) : null}
                  <NodeInspector
                    node={
                      activeGraph
                        ? activeGraph.nodes.find((n) => n.id === activeNodeId) ||
                          activeGraph.nodes[0] ||
                          null
                        : null
                    }
                    graph={activeGraph || selected.graph}
                    busy={busy}
                    onSaveFields={async (nodeId, fields) => {
                      mutateGraph(
                        (g) => updateNodeFields(g, nodeId, fields),
                        'Step updated (unsaved).'
                      );
                    }}
                    onAddAfter={async (afterId) => {
                      if (!activeGraph) return;
                      const next = insertAgentAfter(activeGraph, afterId);
                      const added = next.nodes.find(
                        (n) => n.type === 'agent' && !activeGraph.nodes.some((o) => o.id === n.id)
                      );
                      applyDraftGraph(next, added?.id || afterId);
                      setStatus('Agent step added (unsaved).');
                    }}
                    onRemove={async (nodeId) => {
                      if (!activeGraph) return;
                      const target = activeGraph.nodes.find((n) => n.id === nodeId);
                      try {
                        const next =
                          target?.type === 'agent'
                            ? removeAgentNode(activeGraph, nodeId)
                            : removeNode(activeGraph, nodeId);
                        applyDraftGraph(
                          next,
                          topologicalOrder(next)[0] ||
                            next.nodes.find((n) => n.type !== 'trigger')?.id ||
                            null
                        );
                        setStatus('Step removed (unsaved).');
                      } catch (error) {
                        setStatus(error instanceof Error ? error.message : String(error));
                      }
                    }}
                    onSplit={async (nodeId) => {
                      if (!activeGraph) return;
                      try {
                        const next = splitAgentPrompt(activeGraph, nodeId);
                        applyDraftGraph(next);
                        setStatus('Agent split into sequential steps (unsaved).');
                      } catch (error) {
                        setStatus(error instanceof Error ? error.message : String(error));
                      }
                    }}
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

function WorkflowWorkspaceBinder({
  workflow,
  projects,
  folders,
  loading,
  disabled,
  onChange,
  onRefreshOptions,
}: {
  workflow: WorkflowDefinition;
  projects: UnifiedCompanyProject[];
  folders: PersonalFolder[];
  loading: boolean;
  disabled?: boolean;
  onChange: (binding: Partial<WorkflowBinding>) => void;
  onRefreshOptions: () => void;
}) {
  const kindValue =
    workflow.division === 'project'
      ? workflow.canonicalKey
        ? `project:${workflow.canonicalKey}`
        : workflow.hubProjectId
          ? `project:hub:${workflow.hubProjectId}`
          : workflow.launchpadProjectId != null
            ? `project:lp:${workflow.launchpadProjectId}`
            : 'general'
      : workflow.division === 'folder' && workflow.folderId
        ? `folder:${workflow.folderId}`
        : workflow.division;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-[11px] font-medium text-text-muted" htmlFor={`wf-space-${workflow.id}`}>
        Workspace
      </label>
      <select
        id={`wf-space-${workflow.id}`}
        disabled={disabled}
        value={kindValue}
        onFocus={onRefreshOptions}
        onChange={(e) => {
          const value = e.target.value;
          if (value === 'general' || value === 'hub') {
            onChange({
              division: value,
              hubProjectId: null,
              hubProjectName: null,
              launchpadProjectId: null,
              launchpadProjectName: null,
              folderId: null,
              folderName: null,
              canonicalKey: null,
            });
            return;
          }
          if (value.startsWith('folder:')) {
            const folderId = value.slice('folder:'.length);
            const folder = folders.find((f) => f.id === folderId);
            onChange({
              division: 'folder',
              folderId,
              folderName: folder?.name || folderId,
              hubProjectId: null,
              hubProjectName: null,
              launchpadProjectId: null,
              launchpadProjectName: null,
              canonicalKey: null,
            });
            return;
          }
          if (value.startsWith('project:')) {
            const key = value.slice('project:'.length);
            const project =
              projects.find((p) => p.canonicalKey === key) ||
              projects.find((p) => `hub:${p.hubProjectId}` === key) ||
              projects.find((p) => p.launchpadProjectId != null && `lp:${p.launchpadProjectId}` === key);
            if (project) {
              const fields = sessionFieldsFromActiveDivision(
                activeDivisionFromUnifiedProject(project)
              );
              onChange(fields);
            }
          }
        }}
        className="max-w-[16rem] rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text-primary disabled:opacity-50"
      >
        <option value="general">General</option>
        <option value="hub">Hub</option>
        <optgroup label={loading ? 'Projects…' : 'Projects'}>
          {projects.map((p) => (
            <option key={p.canonicalKey} value={`project:${p.canonicalKey}`}>
              {p.name}
            </option>
          ))}
        </optgroup>
        <optgroup label={loading ? 'Folders…' : 'Folders'}>
          {folders.map((f) => (
            <option key={f.id} value={`folder:${f.id}`}>
              {f.name}
            </option>
          ))}
        </optgroup>
      </select>
      <span className="text-[11px] text-text-muted">{workflowWorkspaceLabel(workflow)}</span>
    </div>
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
          Review the step graph, inspect approval gates, then enable when you trust the graph.
        </p>
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  graph,
  busy,
  onSaveFields,
  onAddAfter,
  onRemove,
  onSplit,
}: {
  node: WorkflowNode | null;
  graph: WorkflowGraph;
  busy?: boolean;
  onSaveFields: (
    nodeId: string,
    fields: {
      label?: string;
      prompt?: string;
      model?: string | null;
      provider?: string | null;
      message?: string;
    }
  ) => Promise<void>;
  onAddAfter: (afterId: string) => Promise<void>;
  onRemove: (nodeId: string) => Promise<void>;
  onSplit: (nodeId: string) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [message, setMessage] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [models, setModels] = useState<BackendModelInfo[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!node) return;
    setLabel(node.label || '');
    setPrompt(node.type === 'agent' ? node.prompt || '' : '');
    setMessage(
      node.type === 'approval' || node.type === 'notify' ? node.message || '' : ''
    );
    if (node.type === 'agent' && node.model) {
      setModelKey(`${node.provider || ''}::${node.model}`);
    } else {
      setModelKey('');
    }
    setDirty(false);
  }, [node]);

  useEffect(() => {
    if (!window.electronAPI?.config?.listBackendModels) return;
    void window.electronAPI.config
      .listBackendModels()
      .then((items) => setModels(items || []))
      .catch(() => setModels([]));
  }, []);

  if (!node) return null;
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  const agentCount = graph.nodes.filter((n) => n.type === 'agent').length;
  const canRemove =
    node.type !== 'trigger' &&
    (node.type !== 'agent' || agentCount > 1);
  const canSplit =
    node.type === 'agent' && (prompt.includes('\n\n') || prompt.trim().length > 80);

  const save = async () => {
    if (node.type === 'agent') {
      let model: string | null = null;
      let provider: string | null = null;
      if (modelKey) {
        const [p, ...rest] = modelKey.split('::');
        provider = p || null;
        model = rest.join('::') || null;
      }
      await onSaveFields(node.id, {
        label,
        prompt,
        model,
        provider,
      });
    } else if (node.type === 'approval' || node.type === 'notify') {
      await onSaveFields(node.id, { label, message });
    } else {
      await onSaveFields(node.id, { label });
    }
    setDirty(false);
  };

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
            <p className="text-sm font-semibold text-text-primary">Step settings</p>
            <span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
              {meta.label}
            </span>
          </div>
          <p className="text-xs text-text-muted">{meta.blurb}</p>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        <label className="block space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
            Label
          </span>
          <input
            value={label}
            disabled={busy || node.type === 'trigger'}
            onChange={(e) => {
              setLabel(e.target.value);
              setDirty(true);
            }}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
          />
        </label>

        {node.type === 'agent' ? (
          <>
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                Instructions
              </span>
              <textarea
                value={prompt}
                disabled={busy}
                rows={5}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setDirty(true);
                }}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-5 text-text-primary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                Model
              </span>
              <select
                value={modelKey}
                disabled={busy}
                onChange={(e) => {
                  setModelKey(e.target.value);
                  setDirty(true);
                }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
              >
                <option value="">Default (app model)</option>
                {models.map((m) => (
                  <option key={`${m.provider}:${m.id}`} value={`${m.provider}::${m.id}`}>
                    {m.name || shortModelLabel(m.id)} · {m.provider}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}

        {node.type === 'approval' || node.type === 'notify' ? (
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
              Message
            </span>
            <textarea
              value={message}
              disabled={busy}
              rows={3}
              onChange={(e) => {
                setMessage(e.target.value);
                setDirty(true);
              }}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-5 text-text-primary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
            />
          </label>
        ) : null}

        {node.type === 'trigger' ? (
          <div className="rounded-xl border border-border-muted/80 bg-background px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
              Detail
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
              {nodeSummary(node)}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {node.type !== 'trigger' ? (
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() => void save()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              Save step
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void onAddAfter(node.id)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            Add agent after
          </button>
          {canSplit ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onSplit(node.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50"
            >
              Split into agents
            </button>
          ) : null}
          {canRemove ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onRemove(node.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-xs font-medium text-error hover:bg-error/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove step
            </button>
          ) : null}
        </div>
      </div>

      {node.type === 'approval' ? (
        <p className="mt-2 text-[11px] leading-4 text-accent">
          When this step runs, York pauses and asks you to allow or deny before any later stages.
        </p>
      ) : null}
    </div>
  );
}
