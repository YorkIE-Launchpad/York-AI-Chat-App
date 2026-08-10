/**
 * Lightweight visual workflow review canvas (M4).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkflowDefinition, WorkflowNode } from '../../../shared/workflows';
import { SettingsContentSection } from './shared';

export function SettingsWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposeText, setProposeText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.workflows) return;
    setWorkflows(await window.electronAPI.workflows.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) || null,
    [workflows, selectedId]
  );

  const propose = async () => {
    if (!proposeText.trim()) return;
    setBusy(true);
    try {
      const draft = await window.electronAPI.workflows.propose(proposeText.trim());
      setSelectedId(draft.id);
      setProposeText('');
      setStatus('Draft workflow created — review graph, then enable/run.');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const setStatusFlag = async (statusValue: 'draft' | 'enabled' | 'disabled') => {
    if (!selected) return;
    await window.electronAPI.workflows.update(selected.id, { status: statusValue });
    await refresh();
  };

  const run = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.workflows.run(selected.id);
      setStatus(`Run ${result.runId.slice(0, 8)}… → ${result.status}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    await window.electronAPI.workflows.delete(selected.id);
    setSelectedId(null);
    await refresh();
  };

  return (
    <div className="space-y-6">
      <SettingsContentSection
        title="Visual workflows"
        description="Agent-proposed automations with triggers, agent steps, and approval gates on the checkpoint runner."
      >
        <div className="flex gap-2">
          <input
            value={proposeText}
            onChange={(e) => setProposeText(e.target.value)}
            placeholder='Describe automation, e.g. "weekday 9am Hub leave + calendar brief"'
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void propose()}
            className="rounded-lg bg-accent px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            Propose
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[220px_1fr]">
          <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-border-muted p-2">
            {workflows.length === 0 ? (
              <p className="p-2 text-xs text-text-muted">No workflows yet.</p>
            ) : (
              workflows.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setSelectedId(w.id)}
                  className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${
                    selectedId === w.id ? 'bg-accent/10' : 'hover:bg-surface-hover'
                  }`}
                >
                  <div className="font-medium truncate">{w.name}</div>
                  <div className="text-[11px] text-text-muted">{w.status}</div>
                </button>
              ))
            )}
          </div>

          <div className="rounded-lg border border-border-muted p-3">
            {!selected ? (
              <p className="text-sm text-text-muted">Select a workflow to review the graph.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 className="text-base font-semibold text-text-primary">{selected.name}</h4>
                    <p className="text-xs text-text-muted">{selected.description || 'No description'}</p>
                    <p className="mt-1 text-[11px] text-text-muted">Status: {selected.status}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => void setStatusFlag('enabled')}
                      className="rounded-md border border-border px-2 py-1 text-xs"
                    >
                      Enable
                    </button>
                    <button
                      type="button"
                      onClick={() => void setStatusFlag('disabled')}
                      className="rounded-md border border-border px-2 py-1 text-xs"
                    >
                      Disable
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run()}
                      className="rounded-md bg-accent px-2 py-1 text-xs text-white disabled:opacity-50"
                    >
                      Run now
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove()}
                      className="rounded-md border border-border px-2 py-1 text-xs text-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <WorkflowCanvas nodes={selected.graph.nodes} edges={selected.graph.edges} />
              </>
            )}
          </div>
        </div>
        {status && <p className="mt-2 text-xs text-text-muted">{status}</p>}
      </SettingsContentSection>
    </div>
  );
}

function WorkflowCanvas({
  nodes,
  edges,
}: {
  nodes: WorkflowNode[];
  edges: Array<{ id: string; from: string; to: string }>;
}) {
  const width = 720;
  const height = 220;
  const positions = new Map(
    nodes.map((n, i) => [
      n.id,
      {
        x: n.x ?? 40 + i * 160,
        y: n.y ?? 80,
      },
    ])
  );

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-border-muted bg-background-secondary/40">
      <svg width={width} height={height} className="min-w-full">
        {edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={edge.id}
              x1={from.x + 60}
              y1={from.y + 24}
              x2={to.x}
              y2={to.y + 24}
              stroke="currentColor"
              className="text-border"
              strokeWidth={1.5}
              markerEnd="url(#arrow)"
            />
          );
        })}
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" className="fill-current text-text-muted" />
          </marker>
        </defs>
        {nodes.map((node) => {
          const pos = positions.get(node.id)!;
          return (
            <g key={node.id} transform={`translate(${pos.x}, ${pos.y})`}>
              <rect
                width={120}
                height={48}
                rx={8}
                className={
                  node.type === 'approval'
                    ? 'fill-amber-500/15 stroke-amber-600'
                    : 'fill-background stroke-border'
                }
                strokeWidth={1.5}
              />
              <text x={8} y={18} className="fill-current text-text-muted" fontSize={10}>
                {node.type}
              </text>
              <text x={8} y={34} className="fill-current text-text-primary" fontSize={11}>
                {(node.label || node.id).slice(0, 16)}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="border-t border-border-muted px-3 py-2 text-[11px] text-text-muted">
        Approval nodes always require PermissionDialog / remote approval — never auto-skipped.
      </p>
    </div>
  );
}
