import { useCallback, useEffect, useRef, useState } from 'react';
import { Briefcase, Building2, ChevronDown, Layers, Loader2 } from 'lucide-react';
import { useAppStore } from '../store';
import type { ActiveDivision, AllocatedHubProject } from '../../shared/workspace-division';
import { divisionLabel } from '../../shared/workspace-division';

interface DivisionSwitcherProps {
  compact?: boolean;
  /** When true, show project picker inline after choosing Project. */
  allowClear?: boolean;
}

export function DivisionSwitcher({ compact = false, allowClear = false }: DivisionSwitcherProps) {
  const activeDivision = useAppStore((s) => s.activeDivision);
  const setActiveDivision = useAppStore((s) => s.setActiveDivision);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const [projects, setProjects] = useState<AllocatedHubProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setPickingProject(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    setProjectsError(null);
    try {
      const api = window.electronAPI?.hub;
      if (!api?.listAllocatedProjects) {
        setProjects([]);
        setProjectsError('Hub allocations unavailable');
        return;
      }
      const result = await api.listAllocatedProjects();
      if (!result.success) {
        setProjects([]);
        setProjectsError(result.error || 'Failed to load projects');
        return;
      }
      setProjects(result.projects || []);
      if (!(result.projects || []).length) {
        setProjectsError('No project allocations');
      }
    } catch (error) {
      setProjects([]);
      setProjectsError(error instanceof Error ? error.message : 'Failed to load projects');
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  const selectDivision = useCallback(
    async (division: ActiveDivision) => {
      if (division.kind === 'project') {
        setPickingProject(true);
        await loadProjects();
        return;
      }
      setActiveDivision(division);
      setMenuOpen(false);
      setPickingProject(false);
    },
    [loadProjects, setActiveDivision]
  );

  const selectProject = useCallback(
    (project: AllocatedHubProject) => {
      setActiveDivision({
        kind: 'project',
        hubProjectId: project.id,
        hubProjectName: project.name,
      });
      setMenuOpen(false);
      setPickingProject(false);
    },
    [setActiveDivision]
  );

  const label = divisionLabel(activeDivision);
  const Icon =
    activeDivision?.kind === 'hub'
      ? Building2
      : activeDivision?.kind === 'project'
        ? Briefcase
        : Layers;

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => {
          setMenuOpen((open) => !open);
          setPickingProject(false);
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
          {!pickingProject ? (
            <div className="py-1">
              <MenuItem
                icon={Layers}
                label="General"
                description="Personal use · your OpenRouter key"
                active={activeDivision?.kind === 'general'}
                onClick={() => void selectDivision({ kind: 'general' })}
              />
              <MenuItem
                icon={Building2}
                label="Hub"
                description="People & HR · York-managed models"
                active={activeDivision?.kind === 'hub'}
                onClick={() => void selectDivision({ kind: 'hub' })}
              />
              <MenuItem
                icon={Briefcase}
                label="Project"
                description="Client project · York-managed models"
                active={activeDivision?.kind === 'project'}
                onClick={() =>
                  void selectDivision({ kind: 'project', hubProjectId: '', hubProjectName: '' })
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
                <span>Allocated projects</span>
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
              {!loadingProjects &&
                projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className={`w-full px-3 py-2 text-left hover:bg-bg-secondary ${
                      activeDivision?.kind === 'project' &&
                      activeDivision.hubProjectId === project.id
                        ? 'bg-bg-secondary'
                        : ''
                    }`}
                    onClick={() => selectProject(project)}
                  >
                    <div className="truncate text-sm font-medium text-text-primary">
                      {project.name}
                    </div>
                    {project.title || project.hours != null ? (
                      <div className="truncate text-xs text-text-muted">
                        {[project.title, project.hours != null ? `${project.hours}h` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    ) : null}
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
  onClick,
}: {
  icon: typeof Layers;
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-bg-secondary ${
        active ? 'bg-bg-secondary' : ''
      }`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        <span className="block text-xs text-text-muted">{description}</span>
      </span>
    </button>
  );
}
