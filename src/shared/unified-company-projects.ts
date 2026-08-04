/**
 * Merge Hub allocations + LaunchPad projects into one company-project catalog.
 * Dedup key: LaunchPad.projectId (Hub id string) === Hub.id
 */

import type { AllocatedHubProject } from './workspace-division';

export interface LaunchPadProjectListItem {
  /** LaunchPad numeric project id */
  id: number;
  name: string;
  /** Optional Hub project id stored on LaunchPad as `projectId` */
  hubProjectId?: string | null;
  slug?: string | null;
  isActive?: boolean;
}

export interface CompanyProjectSources {
  hub?: boolean;
  launchpad?: boolean;
}

export interface UnifiedCompanyProject {
  /** Stable division key: hub:{hubId} or lp:{lpId} */
  canonicalKey: string;
  name: string;
  sources: CompanyProjectSources;
  hubProjectId?: string;
  hubProjectName?: string;
  launchpadProjectId?: number;
  launchpadProjectName?: string;
}

export function hubCanonicalKey(hubProjectId: string): string {
  return `hub:${hubProjectId.trim()}`;
}

export function launchpadCanonicalKey(launchpadProjectId: number): string {
  return `lp:${launchpadProjectId}`;
}

export function canonicalKeyForUnified(project: UnifiedCompanyProject): string {
  if (project.hubProjectId?.trim()) {
    return hubCanonicalKey(project.hubProjectId);
  }
  if (project.launchpadProjectId != null && Number.isFinite(project.launchpadProjectId)) {
    return launchpadCanonicalKey(project.launchpadProjectId);
  }
  return project.canonicalKey;
}

/**
 * Merge Hub + LaunchPad lists.
 * 1. Hub rows always emit an entry (attach LP when projectId matches).
 * 2. LaunchPad rows with no Hub id, or Hub id not in Hub list, emit LP-only.
 */
export function mergeHubAndLaunchpadProjects(
  hubProjects: AllocatedHubProject[],
  launchpadProjects: LaunchPadProjectListItem[]
): UnifiedCompanyProject[] {
  const hubById = new Map<string, AllocatedHubProject>();
  for (const hub of hubProjects) {
    const id = typeof hub.id === 'string' ? hub.id.trim() : '';
    if (!id) continue;
    hubById.set(id, hub);
  }

  const lpByHubId = new Map<string, LaunchPadProjectListItem>();
  const lpUnlinked: LaunchPadProjectListItem[] = [];
  const seenLpIds = new Set<number>();

  for (const lp of launchpadProjects) {
    if (!Number.isFinite(lp.id) || seenLpIds.has(lp.id)) continue;
    seenLpIds.add(lp.id);
    const hubLink =
      typeof lp.hubProjectId === 'string' && lp.hubProjectId.trim() ? lp.hubProjectId.trim() : null;
    if (hubLink && hubById.has(hubLink)) {
      // Keep first match per Hub id (unique at create on LaunchPad)
      if (!lpByHubId.has(hubLink)) {
        lpByHubId.set(hubLink, lp);
      }
    } else {
      lpUnlinked.push(lp);
    }
  }

  const merged: UnifiedCompanyProject[] = [];

  for (const hub of hubById.values()) {
    const lp = lpByHubId.get(hub.id);
    if (lp) {
      merged.push({
        canonicalKey: hubCanonicalKey(hub.id),
        name: hub.name || lp.name,
        sources: { hub: true, launchpad: true },
        hubProjectId: hub.id,
        hubProjectName: hub.name,
        launchpadProjectId: lp.id,
        launchpadProjectName: lp.name,
      });
    } else {
      merged.push({
        canonicalKey: hubCanonicalKey(hub.id),
        name: hub.name,
        sources: { hub: true },
        hubProjectId: hub.id,
        hubProjectName: hub.name,
      });
    }
  }

  for (const lp of lpUnlinked) {
    const hubLink =
      typeof lp.hubProjectId === 'string' && lp.hubProjectId.trim()
        ? lp.hubProjectId.trim()
        : undefined;
    merged.push({
      canonicalKey: launchpadCanonicalKey(lp.id),
      name: lp.name,
      sources: { launchpad: true },
      // Hub id may be present but user has no allocation — still LP-only entry
      hubProjectId: undefined,
      hubProjectName: undefined,
      launchpadProjectId: lp.id,
      launchpadProjectName: lp.name,
      // Preserve linked hub id for display tooling only when allocated (not here)
      ...(hubLink ? {} : {}),
    });
    // Silence unused when hubLink set but not allocated — intentional LP-only
    void hubLink;
  }

  merged.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  );
  return merged;
}

/** Parse LaunchPad GET /api/projects payload into list items. */
export function parseLaunchPadProjectsPayload(payload: unknown): LaunchPadProjectListItem[] {
  const rows = unwrapArray(payload);
  const out: LaunchPadProjectListItem[] = [];
  const seen = new Set<number>();

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const idRaw = rec.id;
    const id =
      typeof idRaw === 'number' && Number.isFinite(idRaw)
        ? idRaw
        : typeof idRaw === 'string' && idRaw.trim() && !Number.isNaN(Number(idRaw))
          ? Number(idRaw)
          : NaN;
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);

    const name =
      (typeof rec.name === 'string' && rec.name.trim()
        ? rec.name.trim()
        : typeof rec.title === 'string' && rec.title.trim()
          ? rec.title.trim()
          : String(id)) || String(id);

    // LaunchPad stores Hub link as `projectId` (string). Also accept hubProjectId.
    const hubProjectId =
      stringOrNull(rec.projectId) ??
      stringOrNull(rec.hubProjectId) ??
      stringOrNull(rec.hub_project_id);

    const slug = typeof rec.slug === 'string' ? rec.slug : null;
    const isActive =
      typeof rec.isActive === 'boolean'
        ? rec.isActive
        : typeof rec.is_active === 'boolean'
          ? rec.is_active
          : undefined;

    out.push({ id, name, hubProjectId, slug, isActive });
  }

  return out;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function unwrapArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const rec = payload as Record<string, unknown>;
  for (const key of ['data', 'projects', 'items', 'results']) {
    const nested = rec[key];
    if (Array.isArray(nested)) return nested;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const inner = nested as Record<string, unknown>;
      for (const k of ['projects', 'items', 'data', 'results']) {
        if (Array.isArray(inner[k])) return inner[k] as unknown[];
      }
    }
  }
  return [];
}
