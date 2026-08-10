import type { UnifiedCompanyProject } from '../../shared/unified-company-projects';
import { canonicalKeyForUnified } from '../../shared/unified-company-projects';

export const RECENT_PROJECTS_STORAGE_KEY = 'york:recent-company-projects';
export const RECENT_PROJECTS_LIMIT = 5;

function isRecentProject(value: unknown): value is UnifiedCompanyProject {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<UnifiedCompanyProject>;
  return typeof p.canonicalKey === 'string' && p.canonicalKey.length > 0 && typeof p.name === 'string';
}

/** Prepend a project and keep at most `limit` unique entries (by canonical key). */
export function pushRecentProject(
  existing: UnifiedCompanyProject[],
  project: UnifiedCompanyProject,
  limit = RECENT_PROJECTS_LIMIT
): UnifiedCompanyProject[] {
  const key = canonicalKeyForUnified(project);
  const next: UnifiedCompanyProject = {
    ...project,
    canonicalKey: key,
  };
  const rest = existing.filter((p) => canonicalKeyForUnified(p) !== key);
  return [next, ...rest].slice(0, Math.max(0, limit));
}

/**
 * Resolve stored recents against the live project list (prefer live metadata),
 * preserving recent order. Drops recents that no longer appear in `projects`.
 */
export function resolveRecentProjects(
  recents: UnifiedCompanyProject[],
  projects: UnifiedCompanyProject[],
  limit = RECENT_PROJECTS_LIMIT
): UnifiedCompanyProject[] {
  const byKey = new Map(projects.map((p) => [canonicalKeyForUnified(p), p]));
  const resolved: UnifiedCompanyProject[] = [];
  const seen = new Set<string>();

  for (const recent of recents) {
    const key = canonicalKeyForUnified(recent);
    if (seen.has(key)) continue;
    const live = byKey.get(key);
    if (!live) continue;
    seen.add(key);
    resolved.push(live);
    if (resolved.length >= limit) break;
  }

  return resolved;
}

export function readRecentProjects(): UnifiedCompanyProject[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecentProject)
      .map((p) => ({
        ...p,
        canonicalKey: canonicalKeyForUnified(p),
        sources: p.sources && typeof p.sources === 'object' ? p.sources : {},
      }))
      .slice(0, RECENT_PROJECTS_LIMIT);
  } catch {
    return [];
  }
}

export function writeRecentProjects(projects: UnifiedCompanyProject[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      RECENT_PROJECTS_STORAGE_KEY,
      JSON.stringify(projects.slice(0, RECENT_PROJECTS_LIMIT))
    );
  } catch {
    // Ignore quota / private mode failures
  }
}

export function rememberRecentProject(project: UnifiedCompanyProject): UnifiedCompanyProject[] {
  const next = pushRecentProject(readRecentProjects(), project);
  writeRecentProjects(next);
  return next;
}
