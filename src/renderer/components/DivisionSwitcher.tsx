import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Briefcase,
  Building2,
  ChevronDown,
  FolderPlus,
  Layers,
  Loader2,
  Folder,
  Lock,
  Search,
} from 'lucide-react';
import { useAppStore } from '../store';
import type { ActiveDivision, PersonalFolder } from '../../shared/workspace-division';
import {
  activeDivisionFromUnifiedProject,
  companyProjectSourceLabel,
  divisionLabel,
} from '../../shared/workspace-division';
import type { UnifiedCompanyProject } from '../../shared/unified-company-projects';
import { canonicalKeyForUnified, filterCompanyProjects } from '../../shared/unified-company-projects';
import { hasOpenRouterUserApiKey } from '../../shared/openrouter-user-key';
import {
  rememberRecentProject,
  resolveRecentProjects,
  readRecentProjects,
} from '../utils/recent-projects';

interface DivisionSwitcherProps {
  compact?: boolean;
  /** When true, show project picker inline after choosing Project. */
  allowClear?: boolean;
}

export function DivisionSwitcher({ compact = false, allowClear = false }: DivisionSwitcherProps) {
  const activeDivision = useAppStore((s) => s.activeDivision);
  const setActiveDivision = useAppStore((s) => s.setActiveDivision);
  const appConfig = useAppStore((s) => s.appConfig);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const hasOpenRouterKey = hasOpenRouterUserApiKey(appConfig?.openRouterUserApiKey);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [projects, setProjects] = useState<UnifiedCompanyProject[]>([]);
  const [folders, setFolders] = useState<PersonalFolder[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [staleProjectWarning, setStaleProjectWarning] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const projectSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setPickingProject(false);
        setPickingFolder(false);
        setProjectQuery('');
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!pickingProject) {
      setProjectQuery('');
      return;
    }
    if (loadingProjects || projects.length === 0) return;
    const id = window.setTimeout(() => projectSearchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [pickingProject, loadingProjects, projects.length]);

  const loadProjects = useCallback(async (): Promise<UnifiedCompanyProject[]> => {
    setLoadingProjects(true);
    setProjectsError(null);
    try {
      const api = window.electronAPI?.projects;
      if (!api?.listUnified) {
        const hubApi = window.electronAPI?.hub;
        if (!hubApi?.listAllocatedProjects) {
          setProjects([]);
          setProjectsError('Projects unavailable');
          return [];
        }
        const result = await hubApi.listAllocatedProjects();
        if (!result.success) {
          setProjects([]);
          setProjectsError(result.error || 'Failed to load projects');
          return [];
        }
        const mapped = (result.projects || []).map((p) => ({
          canonicalKey: `hub:${p.id}`,
          name: p.name,
          sources: { hub: true as const },
          hubProjectId: p.id,
          hubProjectName: p.name,
        }));
        setProjects(mapped);
        if (!mapped.length) {
          setProjectsError('No projects');
        }
        return mapped;
      }
      const result = await api.listUnified();
      const loaded = result.projects || [];
      setProjects(loaded);
      const partial: string[] = [];
      if (result.hubError) partial.push(`Hub: ${result.hubError}`);
      if (result.launchpadError) partial.push(`LaunchPad: ${result.launchpadError}`);
      if (!loaded.length) {
        setProjectsError(partial.join(' · ') || result.error || 'No projects');
      } else if (partial.length) {
        setProjectsError(partial.join(' · '));
      }
      return loaded;
    } catch (error) {
      setProjects([]);
      setProjectsError(error instanceof Error ? error.message : 'Failed to load projects');
      return [];
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  // Warn when the stored project workspace is no longer in the live allocation list.
  useEffect(() => {
    if (activeDivision?.kind !== 'project') {
      setStaleProjectWarning(null);
      return;
    }

    const division = activeDivision;
    const activeKey = division.canonicalKey;
    const projectName = division.name || 'This project';
    let cancelled = false;

    void (async () => {
      const loaded = await loadProjects();
      if (cancelled) return;

      const found = loaded.some((p) => canonicalKeyForUnified(p) === activeKey);
      if (!found) {
        const message = `"${projectName}" is no longer in your project list. Hub lookups may fail — select another project in the sidebar.`;
        setStaleProjectWarning(message);
        useAppStore.getState().setGlobalNotice({
          id: `stale-project:${activeKey}`,
          type: 'warning',
          message,
          durationMs: 12_000,
        });
      } else {
        setStaleProjectWarning(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeDivision, loadProjects]);

  const loadFolders = useCallback(async () => {
    setLoadingFolders(true);
    try {
      const api = window.electronAPI?.folders;
      if (!api?.list) {
        setFolders([]);
        return;
      }
      const result = await api.list();
      setFolders(result.folders || []);
    } catch {
      setFolders([]);
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  const selectDivision = useCallback(
    async (division: ActiveDivision) => {
      if (
        (division.kind === 'general' || division.kind === 'folder') &&
        !hasOpenRouterUserApiKey(appConfig?.openRouterUserApiKey)
      ) {
        setSettingsTab('general');
        setShowSettings(true);
        setMenuOpen(false);
        return;
      }
      if (division.kind === 'project') {
        setPickingFolder(false);
        setPickingProject(true);
        await loadProjects();
        return;
      }
      setActiveDivision(division);
      setMenuOpen(false);
      setPickingProject(false);
      setPickingFolder(false);
    },
    [
      appConfig?.openRouterUserApiKey,
      loadProjects,
      setActiveDivision,
      setSettingsTab,
      setShowSettings,
    ]
  );

  const selectProject = useCallback(
    (project: UnifiedCompanyProject) => {
      rememberRecentProject(project);
      setActiveDivision(activeDivisionFromUnifiedProject(project));
      setMenuOpen(false);
      setPickingProject(false);
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

  const selectFolder = useCallback(
    (folder: PersonalFolder) => {
      if (!hasOpenRouterUserApiKey(appConfig?.openRouterUserApiKey)) {
        setSettingsTab('general');
        setShowSettings(true);
        setMenuOpen(false);
        return;
      }
      setActiveDivision({
        kind: 'folder',
        folderId: folder.id,
        folderName: folder.name,
      });
      setMenuOpen(false);
      setPickingFolder(false);
    },
    [appConfig?.openRouterUserApiKey, setActiveDivision, setSettingsTab, setShowSettings]
  );

  const createFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const api = window.electronAPI?.folders;
    if (!api?.create) return;
    const result = await api.create(name);
    if (result.success && result.folder) {
      setNewFolderName('');
      selectFolder(result.folder);
    }
  }, [newFolderName, selectFolder]);

  const label = divisionLabel(activeDivision);
  const Icon =
    activeDivision?.kind === 'hub'
      ? Building2
      : activeDivision?.kind === 'project'
        ? Briefcase
        : activeDivision?.kind === 'folder'
          ? Folder
          : Layers;

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => {
          setMenuOpen((open) => !open);
          setPickingProject(false);
          setPickingFolder(false);
          setProjectQuery('');
        }}
        className={`flex w-full items-center gap-2 rounded-lg border border-border bg-background text-left text-text-primary hover:bg-surface-hover transition-colors ${
          compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'
        }`}
        title="Switch workspace"
      >
        <Icon className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} shrink-0 text-text-muted`} />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <ChevronDown
          className={`${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} shrink-0 text-text-muted`}
        />
      </button>

      {staleProjectWarning && !menuOpen && (
        <p className="mt-1 px-0.5 text-[10px] leading-snug text-amber-700 dark:text-amber-300">
          {staleProjectWarning}
        </p>
      )}

      {menuOpen && (
        <div className="absolute left-0 right-0 z-40 mt-1 overflow-hidden rounded-lg border border-border bg-background shadow-lg">
          {!pickingProject && !pickingFolder ? (
            <div className="py-1">
              <MenuItem
                icon={Layers}
                label="General"
                description={
                  hasOpenRouterKey
                    ? 'Personal · your OpenRouter API key (not York billing)'
                    : 'Requires your OpenRouter API key — tap to add it'
                }
                active={activeDivision?.kind === 'general'}
                locked={!hasOpenRouterKey}
                onClick={() => void selectDivision({ kind: 'general' })}
              />
              <MenuItem
                icon={Folder}
                label="Folders"
                description={
                  hasOpenRouterKey
                    ? 'Personal folders · your OpenRouter API key'
                    : 'Requires your OpenRouter API key — tap to add it'
                }
                active={activeDivision?.kind === 'folder'}
                locked={!hasOpenRouterKey}
                onClick={() => {
                  if (!hasOpenRouterKey) {
                    setSettingsTab('general');
                    setShowSettings(true);
                    setMenuOpen(false);
                    return;
                  }
                  setPickingProject(false);
                  setPickingFolder(true);
                  void loadFolders();
                }}
              />
              <MenuItem
                icon={Building2}
                label="Hub"
                description="People & HR · York-managed models (no OpenRouter key)"
                active={activeDivision?.kind === 'hub'}
                onClick={() => void selectDivision({ kind: 'hub' })}
              />
              <MenuItem
                icon={Briefcase}
                label="Project"
                description="Hub + LaunchPad · York-managed models (no OpenRouter key)"
                active={activeDivision?.kind === 'project'}
                onClick={() =>
                  void selectDivision({
                    kind: 'project',
                    canonicalKey: '',
                    name: '',
                    sources: {},
                  })
                }
              />
              {allowClear && activeDivision && (
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-xs text-text-muted hover:bg-bg-secondary"
                  onClick={() => {
                    setActiveDivision(null);
                    setMenuOpen(false);
                  }}
                >
                  Clear workspace selection
                </button>
              )}
            </div>
          ) : pickingFolder ? (
            <div className="max-h-72 overflow-y-auto py-1">
              <div className="flex items-center justify-between px-3 py-2 text-xs text-text-muted">
                <button
                  type="button"
                  className="hover:text-text-primary"
                  onClick={() => setPickingFolder(false)}
                >
                  ← Back
                </button>
                <span>Personal folders</span>
              </div>
              <div className="flex gap-1 px-3 pb-2">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createFolder();
                  }}
                  placeholder="New folder name"
                  className="min-w-0 flex-1 rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
                />
                <button
                  type="button"
                  onClick={() => void createFolder()}
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs text-text-primary hover:bg-bg-secondary"
                  title="Create folder"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </button>
              </div>
              {loadingFolders && (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading…
                </div>
              )}
              {!loadingFolders &&
                folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    className={`w-full px-3 py-2 text-left hover:bg-bg-secondary ${
                      activeDivision?.kind === 'folder' && activeDivision.folderId === folder.id
                        ? 'bg-bg-secondary'
                        : ''
                    }`}
                    onClick={() => selectFolder(folder)}
                  >
                    <div className="truncate text-sm font-medium text-text-primary">
                      {folder.name}
                    </div>
                    <div className="truncate text-xs text-text-muted">Your OpenRouter API key</div>
                  </button>
                ))}
              {!loadingFolders && folders.length === 0 && (
                <p className="px-3 py-3 text-xs text-text-muted">No folders yet</p>
              )}
            </div>
          ) : (
            <div className="flex max-h-80 flex-col py-1">
              <div className="flex items-center justify-between px-3 py-2 text-xs text-text-muted">
                <button
                  type="button"
                  className="hover:text-text-primary"
                  onClick={() => setPickingProject(false)}
                >
                  ← Back
                </button>
                <span>Company projects</span>
              </div>
              {!loadingProjects && projects.length > 0 && (
                <div className="px-2 pb-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
                    <input
                      ref={projectSearchRef}
                      type="search"
                      value={projectQuery}
                      onChange={(e) => setProjectQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Escape') return;
                        e.stopPropagation();
                        if (projectQuery) {
                          setProjectQuery('');
                          return;
                        }
                        setPickingProject(false);
                      }}
                      placeholder="Search projects…"
                      aria-label="Search projects"
                      className="w-full rounded border border-border bg-bg-secondary py-1.5 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-muted"
                    />
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {loadingProjects && (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs text-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </div>
                )}
                {!loadingProjects && projectsError && projects.length === 0 && (
                  <p className="px-3 py-3 text-xs text-text-muted">{projectsError}</p>
                )}
                {!loadingProjects && projectsError && projects.length > 0 && (
                  <p className="px-3 py-1 text-xs text-text-muted">{projectsError}</p>
                )}
                {!loadingProjects && visibleRecentProjects.length > 0 && (
                  <>
                    <div className="px-3 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                      Recent
                    </div>
                    {visibleRecentProjects.map((project) => (
                      <ProjectMenuRow
                        key={`recent:${project.canonicalKey}`}
                        project={project}
                        active={
                          activeDivision?.kind === 'project' &&
                          activeDivision.canonicalKey === project.canonicalKey
                        }
                        onSelect={selectProject}
                      />
                    ))}
                    {visibleOtherProjects.length > 0 && (
                      <div className="my-1 border-t border-border" />
                    )}
                  </>
                )}
                {!loadingProjects &&
                  visibleOtherProjects.length > 0 &&
                  visibleRecentProjects.length > 0 && (
                    <div className="px-3 pt-0.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                      All projects
                    </div>
                  )}
                {!loadingProjects &&
                  visibleOtherProjects.map((project) => (
                    <ProjectMenuRow
                      key={project.canonicalKey}
                      project={project}
                      active={
                        activeDivision?.kind === 'project' &&
                        activeDivision.canonicalKey === project.canonicalKey
                      }
                      onSelect={selectProject}
                    />
                  ))}
                {!loadingProjects && projects.length > 0 && !hasProjectMatches && (
                  <p className="px-3 py-3 text-xs text-text-muted">No matching projects</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectMenuRow({
  project,
  active,
  onSelect,
}: {
  project: UnifiedCompanyProject;
  active: boolean;
  onSelect: (project: UnifiedCompanyProject) => void;
}) {
  return (
    <button
      type="button"
      className={`w-full px-3 py-2 text-left hover:bg-bg-secondary ${
        active ? 'bg-bg-secondary' : ''
      }`}
      onClick={() => onSelect(project)}
    >
      <div className="truncate text-sm font-medium text-text-primary">{project.name}</div>
      <div className="truncate text-xs text-text-muted">
        {companyProjectSourceLabel(project.sources)}
      </div>
    </button>
  );
}

function MenuItem({
  icon: Icon,
  label,
  description,
  active,
  locked = false,
  onClick,
}: {
  icon: typeof Layers;
  label: string;
  description: string;
  active: boolean;
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-bg-secondary ${
        active ? 'bg-bg-secondary' : ''
      } ${locked ? 'opacity-90' : ''}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="block text-sm font-medium text-text-primary">{label}</span>
          {locked ? (
            <span className="inline-flex items-center gap-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-[10px] font-medium text-amber-800 dark:text-amber-300">
              <Lock className="h-2.5 w-2.5" />
              Key
            </span>
          ) : null}
        </span>
        <span className="block text-xs text-text-muted">{description}</span>
      </span>
    </button>
  );
}
