/**
 * Summary Trees panel — Build / graph / node detail (OpenHuman-aligned).
 */
import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Loader2, RefreshCw, Trash2, TreePine } from 'lucide-react';
import type {
  SummaryTreeBuildResult,
  SummaryTreeGraph,
  SummaryTreeNode,
  SummaryTreeStats,
} from '../../../shared/summary-tree';
import { SUMMARY_TREE_DISPLAY_SOURCE_THRESHOLD, kindLabel } from '../../../shared/summary-tree';
import { SettingsContentSection } from './shared';
import { KIND_COLOR, SummaryTreeGraphView } from './SummaryTreeGraphView';

export function SettingsSummaryTree() {
  const [graph, setGraph] = useState<SummaryTreeGraph | null>(null);
  const [stats, setStats] = useState<SummaryTreeStats | null>(null);
  const [selected, setSelected] = useState<SummaryTreeNode | null>(null);
  const [showSources, setShowSources] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [wikiCount, setWikiCount] = useState(0);

  const load = useCallback(async (includeSourceLeaves: boolean) => {
    const api = window.electronAPI?.summaryTree;
    if (!api) return;
    const [g, s, c] = await Promise.all([
      api.getGraph({ includeSourceLeaves }),
      api.stats(),
      window.electronAPI?.wiki?.count?.() ?? Promise.resolve({ count: 0 }),
    ]);
    setGraph(g);
    setStats(s);
    setWikiCount(c.count);
  }, []);

  useEffect(() => {
    void load(showSources);
  }, [load, showSources]);

  const build = async () => {
    const api = window.electronAPI?.summaryTree;
    if (!api) return;
    setBusy(true);
    try {
      const result: SummaryTreeBuildResult = await api.build();
      setStatus(
        `Built ${result.nodeCount} nodes · ${result.linkCount} links · ${result.treeCount} trees from ${result.wikiPageCount} wiki pages.`
      );
      const include = result.nodeCount <= SUMMARY_TREE_DISPLAY_SOURCE_THRESHOLD;
      setShowSources(include);
      setSelected(null);
      await load(include);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      await load(showSources);
      setStatus('Graph refreshed.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resetTree = async () => {
    const api = window.electronAPI?.summaryTree;
    if (!api) return;
    if (!window.confirm('Reset the Summary Tree? Wiki pages are kept; only hierarchy is cleared.')) {
      return;
    }
    setBusy(true);
    try {
      await api.reset();
      setStatus('Summary Tree cleared.');
      setSelected(null);
      await load(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const viewVault = async () => {
    const api = window.electronAPI?.summaryTree;
    if (!api) return;
    try {
      const { path } = await api.getVaultPath();
      await window.electronAPI.openPath(path);
      setStatus(`Vault: ${path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const openWikiFromLeaf = async () => {
    if (!selected?.wikiPageId || !window.electronAPI?.wiki) return;
    const page = await window.electronAPI.wiki.get(selected.wikiPageId);
    if (page) {
      setStatus(`Wiki page: ${page.path}`);
    }
  };

  const nodeCount = stats?.nodeCount ?? 0;
  const linkCount = stats?.linkCount ?? 0;
  const dense = nodeCount > SUMMARY_TREE_DISPLAY_SOURCE_THRESHOLD;

  return (
    <div className="space-y-4">
      <SettingsContentSection
        title="Summary Trees"
        description="Hierarchical compress of wiki leaves (Document → L2 → L1 → Source). OpenHuman-style navigation over company memory."
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void build()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <TreePine className="h-3.5 w-3.5" />
            )}
            Build Summary Trees
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resetTree()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-xs font-medium text-error hover:bg-error/10 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Reset Memory Tree
          </button>
          <button
            type="button"
            onClick={() => void viewVault()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            View Vault
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
          <span>
            {nodeCount} nodes · {linkCount} parent-child links
            {stats ? ` · ${stats.treeCount} trees` : ''}
            {wikiCount ? ` · ${wikiCount} wiki pages` : ''}
          </span>
          {dense ? (
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showSources}
                onChange={(e) => setShowSources(e.target.checked)}
              />
              Show source leaves
            </label>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
          {(
            [
              ['source', 'Source'],
              ['l1', 'L1'],
              ['l2', 'L2'],
              ['document', 'Document'],
            ] as const
          ).map(([kind, label]) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: KIND_COLOR[kind] }}
              />
              {label}
            </span>
          ))}
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-border-muted">
          {!graph || graph.nodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
              <TreePine className="h-8 w-8 text-text-muted/70" />
              <p className="text-sm font-medium text-text-primary">No summary tree yet</p>
              <p className="max-w-sm text-xs leading-5 text-text-muted">
                {wikiCount === 0
                  ? 'Ingest Matter / meetings into Memory Wiki first, then Build Summary Trees.'
                  : 'Wiki has pages — click Build Summary Trees to seal L0 leaves into L1 / L2 / Document.'}
              </p>
            </div>
          ) : (
            <SummaryTreeGraphView
              graph={graph}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          )}
        </div>

        {selected ? (
          <div className="mt-3 rounded-xl border border-border-muted bg-background-secondary/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: KIND_COLOR[selected.kind] }}
              />
              <p className="text-sm font-semibold text-text-primary">{selected.title}</p>
              <span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-text-muted">
                {kindLabel(selected.kind)}
              </span>
              <span className="text-[11px] text-text-muted">{selected.treeKey}</span>
            </div>
            <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
              {selected.body.slice(0, 4000)}
            </pre>
            {selected.wikiPageId ? (
              <button
                type="button"
                onClick={() => void openWikiFromLeaf()}
                className="mt-2 text-[11px] font-medium text-accent hover:underline"
              >
                Linked wiki page id: {selected.wikiPageId.slice(0, 8)}…
              </button>
            ) : null}
          </div>
        ) : null}

        {status ? (
          <p className="mt-2 text-xs text-text-secondary" role="status">
            {status}
          </p>
        ) : null}
      </SettingsContentSection>
    </div>
  );
}
