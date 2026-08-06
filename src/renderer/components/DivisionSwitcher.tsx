import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Briefcase,
  Building2,
  ChevronDown,
  FolderPlus,
  Layers,
  Loader2,
  Folder,
  Lock,
} from 'lucide-react';
import { useAppStore } from '../store';
import type { ActiveDivision, PersonalFolder } from '../../shared/workspace-division';
import {
  activeDivisionFromUnifiedProject,
  companyProjectSourceLabel,
  divisionLabel,
} from '../../shared/workspace-division';
import type { UnifiedCompanyProject } from '../../shared/unified-company-projects';
import { hasOpenRouterUserApiKey } from '../../shared/openrouter-user-key';

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
  const [newFolderName, setNewFolderName] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setPickingProject(false);
        setPickingFolder(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    setProjectsError(null);
    try {
      const api = window.electronAPI?.projects;
      if (!api?.listUnified) {
        const hubApi = window.electronAPI?.hub;
        if (!hubApi?.listAllocatedProjects) {
          setProjects([]);
          setProjectsError('Projects unavailable');
          return;
        }
        const result = await hubApi.listAllocatedProjects();
        if (!result.success) {
          setProjects([]);
          setProjectsError(result.error || 'Failed to load projects');
          return;
        }
        setProjects(
          (result.projects || []).map((p) => ({
            canonicalKey: `hub:${p.id}`,
            name: p.name,
            sources: { hub: true as const },
            hubProjectId: p.id,
            hubProjectName: p.name,
          }))
        );
        if (!(result.projects || []).length) {
          setProjectsError('No projects');
        }
        return;
      }
      const result = await api.listUnified();
      setProjects(result.projects || []);
      const partial: string[] = [];
      if (result.hubError) partial.push(`Hub: ${result.hubError}`);
      if (result.launchpadError) partial.push(`LaunchPad: ${result.launchpadError}`);
      if (!(result.projects || []).length) {
        setProjectsError(partial.join(' · ') || result.error || 'No projects');
      } else if (partial.length) {
        setProjectsError(partial.join(' · '));
      }
    } catch (error) {
      setProjects([]);
      setProjectsError(error instanceof Error ? error.message : 'Failed to load projects');
    } finally {
      setLoadingProjects(false);
    }
  }, []);

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
      setActiveDivision(activeDivisionFromUnifiedProject(project));
      setMenuOpen(false);
      setPickingProject(false);
    },
    [setActiveDivision]
  );

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
            <div className="max-h-64 overflow-y-auto py-1">
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
              {!loadingProjects &&
                projects.map((project) => (
                  <button
                    key={project.canonicalKey}
                    type="button"
                    className={`w-full px-3 py-2 text-left hover:bg-bg-secondary ${
                      activeDivision?.kind === 'project' &&
                      activeDivision.canonicalKey === project.canonicalKey
                        ? 'bg-bg-secondary'
                        : ''
                    }`}
                    onClick={() => selectProject(project)}
                  >
                    <div className="truncate text-sm font-medium text-text-primary">
                      {project.name}
                    </div>
                    <div className="truncate text-xs text-text-muted">
                      {companyProjectSourceLabel(project.sources)}
                    </div>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
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
