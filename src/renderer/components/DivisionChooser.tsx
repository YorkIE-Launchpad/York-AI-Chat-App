import { useCallback, useEffect, useMemo, useState } from 'react';
import { Briefcase, Building2, KeyRound, Layers, Loader2, Lock, Search, Users } from 'lucide-react';
import { useAppStore } from '../store';
import type { ClientProjectGroup, UnifiedCompanyProject } from '../../shared/unified-company-projects';
import { canonicalKeyForUnified, filterClientProjectGroups, filterCompanyProjects, groupUnifiedProjectsByClient } from '../../shared/unified-company-projects';
import {
  activeDivisionFromUnifiedProject,
  clientDivisionFromProjects,
  companyProjectSourceLabel,
} from '../../shared/workspace-division';
import { hasOpenRouterUserApiKey } from '../../shared/openrouter-user-key';
import {
  rememberRecentProject,
  resolveRecentProjects,
  readRecentProjects,
} from '../utils/recent-projects';

/**
 * Full chooser shown on Welcome when no active division is selected.
 */
export function DivisionChooser() {
  const setActiveDivision = useAppStore((s) => s.setActiveDivision);
  const appConfig = useAppStore((s) => s.appConfig);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const hasOpenRouterKey = hasOpenRouterUserApiKey(appConfig?.openRouterUserApiKey);

  const openOpenRouterKeySettings = useCallback(() => {
    setSettingsTab('general');
    setShowSettings(true);
  }, [setSettingsTab, setShowSettings]);
  const [pickingProject, setPickingProject] = useState(false);
  const [pickingClient, setPickingClient] = useState(false);
  const [projects, setProjects] = useState<UnifiedCompanyProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const [clientQuery, setClientQuery] = useState('');

  const loadProjects = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const api = window.electronAPI?.projects;
      if (!api?.listUnified) {
        // Fallback: Hub-only list when unified IPC missing
        const hubApi = window.electronAPI?.hub;
        if (!hubApi?.listAllocatedProjects) {
          setProjects([]);
          setError('Projects unavailable in this environment');
          return;
        }
        const result = await hubApi.listAllocatedProjects(forceRefresh);
        if (!result.success) {
          setProjects([]);
          setError(result.error || 'Failed to load projects');
          return;
        }
        setProjects(
          (result.projects || []).map((p) => ({
            canonicalKey: `hub:${p.id}`,
            name: p.name,
            sources: { hub: true },
            hubProjectId: p.id,
            hubProjectName: p.name,
            ...(p.clientName ? { clientName: p.clientName } : {}),
          }))
        );
        if (!(result.projects || []).length) {
          setError('No projects found for your account');
        }
        return;
      }
      const result = await api.listUnified(forceRefresh);
      if (!result.success && !(result.projects || []).length) {
        setProjects([]);
        setError(result.error || 'Failed to load projects');
        return;
      }
      setProjects(result.projects || []);
      const partial: string[] = [];
      if (result.hubError) partial.push(`Hub: ${result.hubError}`);
      if (result.launchpadError) partial.push(`LaunchPad: ${result.launchpadError}`);
      if (!(result.projects || []).length) {
        setError(partial.join(' · ') || 'No projects found for your account');
      } else if (partial.length) {
        setError(partial.join(' · '));
      }
    } catch (err) {
      setProjects([]);
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pickingProject || pickingClient) {
      void loadProjects(pickingClient);
    }
  }, [pickingProject, pickingClient, loadProjects]);

  const selectProject = useCallback(
    (project: UnifiedCompanyProject) => {
      rememberRecentProject(project);
      setActiveDivision(activeDivisionFromUnifiedProject(project));
    },
    [setActiveDivision]
  );

  const recentProjects = useMemo(
    () => resolveRecentProjects(readRecentProjects(), projects),
    [projects]
  );

  const otherProjects = useMemo(() => {
    const recentKeys = new Set(recentProjects.map((p) => canonicalKeyForUnified(p)));
    return projects.filter((p) => !recentKeys.has(canonicalKeyForUnified(p)));
  }, [projects, recentProjects]);

  const visibleRecentProjects = useMemo(
    () => filterCompanyProjects(recentProjects, projectQuery),
    [recentProjects, projectQuery]
  );
  const visibleOtherProjects = useMemo(
    () => filterCompanyProjects(otherProjects, projectQuery),
    [otherProjects, projectQuery]
  );
  const hasProjectMatches = visibleRecentProjects.length > 0 || visibleOtherProjects.length > 0;

  const clientGroups = useMemo(() => groupUnifiedProjectsByClient(projects), [projects]);
  const visibleClientGroups = useMemo(
    () => filterClientProjectGroups(clientGroups, clientQuery),
    [clientGroups, clientQuery]
  );

  const selectClient = useCallback(
    (group: ClientProjectGroup) => {
      setActiveDivision(clientDivisionFromProjects(group.clientName, group.projects));
    },
    [setActiveDivision]
  );

  if (pickingClient) {
    return (
      <div className="mx-auto flex w-full max-w-lg min-h-0 flex-1 flex-col">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <button
            type="button"
            className="text-sm text-text-muted hover:text-text-primary"
            onClick={() => {
              setClientQuery('');
              setPickingClient(false);
            }}
          >
            ← Back
          </button>
          <h2 className="text-sm font-medium text-text-primary">Choose a client</h2>
          <span className="w-12" />
        </div>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading clients…
          </div>
        )}
        {!loading && error && clientGroups.length === 0 && (
          <p className="rounded-lg border border-border-subtle bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">
            {error}
          </p>
        )}
        {!loading && clientGroups.length === 0 && !error && (
          <p className="rounded-lg border border-border-subtle bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">
            No clients found — projects need a client_name from Hub.
          </p>
        )}
        {!loading && clientGroups.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="relative shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                type="search"
                autoFocus
                value={clientQuery}
                onChange={(e) => setClientQuery(e.target.value)}
                placeholder="Search clients…"
                aria-label="Search clients"
                className="w-full rounded-xl border border-border-subtle bg-bg-secondary py-2.5 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-muted"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
              {visibleClientGroups.map((group) => (
                <button
                  key={group.canonicalKey}
                  type="button"
                  onClick={() => selectClient(group)}
                  className="shrink-0 rounded-xl border border-border-subtle bg-bg-secondary px-4 py-3 text-left hover:border-accent/40 hover:bg-bg-tertiary transition-colors"
                >
                  <div className="font-medium text-text-primary">{group.clientName}</div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    {group.projects.length} project{group.projects.length === 1 ? '' : 's'} ·{' '}
                    {group.projects
                      .slice(0, 3)
                      .map((p) => p.name)
                      .join(', ')}
                  </div>
                </button>
              ))}
              {visibleClientGroups.length === 0 && (
                <p className="rounded-lg border border-border-subtle bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">
                  No matching clients
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (pickingProject) {
    return (
      <div className="mx-auto flex w-full max-w-lg min-h-0 flex-1 flex-col">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <button
            type="button"
            className="text-sm text-text-muted hover:text-text-primary"
            onClick={() => {
              setProjectQuery('');
              setPickingProject(false);
            }}
          >
            ← Back
          </button>
          <h2 className="text-sm font-medium text-text-primary">Choose a project</h2>
          <span className="w-12" />
        </div>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading projects…
          </div>
        )}
        {!loading && error && projects.length === 0 && (
          <p className="rounded-lg border border-border-subtle bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">
            {error}
          </p>
        )}
        {!loading && error && projects.length > 0 && (
          <p className="mb-2 text-center text-xs text-text-muted">{error}</p>
        )}
        {!loading && projects.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="relative shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                type="search"
                autoFocus
                value={projectQuery}
                onChange={(e) => setProjectQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  if (projectQuery) {
                    e.preventDefault();
                    setProjectQuery('');
                  }
                }}
                placeholder="Search projects…"
                aria-label="Search projects"
                className="w-full rounded-xl border border-border-subtle bg-bg-secondary py-2.5 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-muted"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
            {visibleRecentProjects.length > 0 && (
              <>
                <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                  Recent
                </div>
                {visibleRecentProjects.map((project) => (
                  <button
                    key={`recent:${project.canonicalKey}`}
                    type="button"
                    onClick={() => selectProject(project)}
                    className="shrink-0 rounded-xl border border-border-subtle bg-bg-secondary px-4 py-3 text-left hover:border-accent/40 hover:bg-bg-tertiary transition-colors"
                  >
                    <div className="font-medium text-text-primary">{project.name}</div>
                    <div className="mt-0.5 text-xs text-text-muted">
                      {companyProjectSourceLabel(project.sources)}
                    </div>
                  </button>
                ))}
                {visibleOtherProjects.length > 0 && (
                  <div className="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                    All projects
                  </div>
                )}
              </>
            )}
            {visibleOtherProjects.map((project) => (
              <button
                key={project.canonicalKey}
                type="button"
                onClick={() => selectProject(project)}
                className="shrink-0 rounded-xl border border-border-subtle bg-bg-secondary px-4 py-3 text-left hover:border-accent/40 hover:bg-bg-tertiary transition-colors"
              >
                <div className="font-medium text-text-primary">{project.name}</div>
                <div className="mt-0.5 text-xs text-text-muted">
                  {companyProjectSourceLabel(project.sources)}
                </div>
              </button>
            ))}
            {!hasProjectMatches && (
              <p className="rounded-lg border border-border-subtle bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">
                No matching projects
              </p>
            )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h2 className="mb-2 text-center text-lg font-semibold text-text-primary">
        Choose a workspace
      </h2>
      <p className="mb-6 text-center text-sm text-text-muted">
        Each workspace has its own chats and experience memory. General needs your own OpenRouter
        API key; Hub uses your personal York allowance; Project uses York-managed models.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <ChooserCard
          icon={Layers}
          title="General"
          description="Personal chats on OpenRouter. Requires your OpenRouter API key (not York billing)."
          locked={!hasOpenRouterKey}
          lockHint="Add your OpenRouter key in Settings first"
          onClick={() => {
            if (!hasOpenRouterKey) {
              openOpenRouterKeySettings();
              return;
            }
            setActiveDivision({ kind: 'general' });
          }}
          secondaryAction={
            !hasOpenRouterKey
              ? {
                  label: 'Add OpenRouter key',
                  onClick: openOpenRouterKeySettings,
                }
              : undefined
          }
        />
        <ChooserCard
          icon={Building2}
          title="Hub"
          description="People, culture, and HRMS — personal York models, no OpenRouter key needed"
          onClick={() => setActiveDivision({ kind: 'hub' })}
        />
        <ChooserCard
          icon={Users}
          title="Client"
          description="All delivery projects for one client — York-managed models"
          onClick={() => setPickingClient(true)}
        />
        <ChooserCard
          icon={Briefcase}
          title="Project"
          description="Single Hub/LaunchPad project — York-managed models"
          onClick={() => setPickingProject(true)}
        />
      </div>
      {!hasOpenRouterKey && (
        <p className="mt-4 text-center text-xs text-text-muted">
          Prefer York models without your own key? Start with Hub, Client, or Project.
        </p>
      )}
    </div>
  );
}

function ChooserCard({
  icon: Icon,
  title,
  description,
  onClick,
  locked = false,
  lockHint,
  secondaryAction,
}: {
  icon: typeof Layers;
  title: string;
  description: string;
  onClick: () => void;
  locked?: boolean;
  lockHint?: string;
  secondaryAction?: { label: string; onClick: () => void };
}) {
  return (
    <div
      className={`flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
        locked
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-border-subtle bg-bg-secondary hover:border-accent/40 hover:bg-bg-tertiary'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col items-start gap-3 text-left"
      >
        <div className="flex w-full items-center justify-between gap-2">
          <Icon
            className={`h-5 w-5 ${locked ? 'text-amber-700 dark:text-amber-400' : 'text-text-muted'}`}
          />
          {locked ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
              <Lock className="h-3 w-3" />
              Key required
            </span>
          ) : null}
        </div>
        <div>
          <div className="font-semibold text-text-primary">{title}</div>
          <div className="mt-1 text-xs leading-relaxed text-text-muted">{description}</div>
          {locked && lockHint ? (
            <div className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-300">
              {lockHint}
            </div>
          ) : null}
        </div>
      </button>
      {secondaryAction ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            secondaryAction.onClick();
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          <KeyRound className="h-3.5 w-3.5" />
          {secondaryAction.label}
        </button>
      ) : null}
    </div>
  );
}
