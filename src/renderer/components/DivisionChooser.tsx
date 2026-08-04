import { useCallback, useEffect, useState } from 'react';
import { Briefcase, Building2, Layers, Loader2 } from 'lucide-react';
import { useAppStore } from '../store';
import type { UnifiedCompanyProject } from '../../shared/unified-company-projects';
import {
  activeDivisionFromUnifiedProject,
  companyProjectSourceLabel,
} from '../../shared/workspace-division';

/**
 * Full chooser shown on Welcome when no active division is selected.
 */
export function DivisionChooser() {
  const setActiveDivision = useAppStore((s) => s.setActiveDivision);
  const [pickingProject, setPickingProject] = useState(false);
  const [projects, setProjects] = useState<UnifiedCompanyProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
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
        const result = await hubApi.listAllocatedProjects();
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
          }))
        );
        if (!(result.projects || []).length) {
          setError('No projects found for your account');
        }
        return;
      }
      const result = await api.listUnified();
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
    if (pickingProject) {
      void loadProjects();
    }
  }, [pickingProject, loadProjects]);

  if (pickingProject) {
    return (
      <div className="mx-auto flex w-full max-w-lg min-h-0 flex-1 flex-col">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <button
            type="button"
            className="text-sm text-text-muted hover:text-text-primary"
            onClick={() => setPickingProject(false)}
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
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
            {projects.map((project) => (
              <button
                key={project.canonicalKey}
                type="button"
                onClick={() => setActiveDivision(activeDivisionFromUnifiedProject(project))}
                className="shrink-0 rounded-xl border border-border-subtle bg-bg-secondary px-4 py-3 text-left hover:border-accent/40 hover:bg-bg-tertiary transition-colors"
              >
                <div className="font-medium text-text-primary">{project.name}</div>
                <div className="mt-0.5 text-xs text-text-muted">
                  {companyProjectSourceLabel(project.sources)}
                </div>
              </button>
            ))}
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
        Each workspace has its own chats and experience memory.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <ChooserCard
          icon={Layers}
          title="General"
          description="Personal use, folders, and your OpenRouter key"
          onClick={() => setActiveDivision({ kind: 'general' })}
        />
        <ChooserCard
          icon={Building2}
          title="Hub"
          description="People, culture, and HRMS"
          onClick={() => setActiveDivision({ kind: 'hub' })}
        />
        <ChooserCard
          icon={Briefcase}
          title="Project"
          description="Hub and LaunchPad delivery projects"
          onClick={() => setPickingProject(true)}
        />
      </div>
    </div>
  );
}

function ChooserCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof Layers;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-3 rounded-xl border border-border-subtle bg-bg-secondary p-4 text-left transition-colors hover:border-accent/40 hover:bg-bg-tertiary"
    >
      <Icon className="h-5 w-5 text-text-muted" />
      <div>
        <div className="font-semibold text-text-primary">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-text-muted">{description}</div>
      </div>
    </button>
  );
}
