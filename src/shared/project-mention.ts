/**
 * Project names for Needs you, Opportunities, and Follow-ups.
 * Only a name that appears on the source is used — never a guess from a meeting title.
 */

const PROJECT_STRING_KEYS = [
  'projectName',
  'project_name',
  'hubProjectName',
  'hub_project_name',
  'launchpadProjectName',
  'launchpad_project_name',
];

export function cleanProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 80) return null;
  if (/^(null|undefined|none|n\/a|unknown|project)$/i.test(name)) return null;
  if (/^[0-9a-f-]{8,}$/i.test(name) && name.includes('-')) return null;
  if (/^\d+$/.test(name)) return null;
  return name;
}

/** Pull a project name out of a connector payload. Free text that is not JSON yields null. */
export function extractProjectName(raw: unknown, depth = 0): string | null {
  if (raw == null || depth > 6) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return extractProjectName(JSON.parse(trimmed) as unknown, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const found = extractProjectName(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  for (const key of PROJECT_STRING_KEYS) {
    const name = cleanProjectName(obj[key]);
    if (name) return name;
  }
  const project = obj.project;
  if (typeof project === 'string') {
    const name = cleanProjectName(project);
    if (name) return name;
  } else if (project && typeof project === 'object' && !Array.isArray(project)) {
    const nested = project as Record<string, unknown>;
    const name = cleanProjectName(
      nested.name ?? nested.displayName ?? nested.title ?? nested.projectName
    );
    if (name) return name;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = extractProjectName(value, depth + 1);
      if (found) return found;
    } else if (typeof value === 'string' && value.trim().startsWith('{')) {
      const found = extractProjectName(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function mentionsProject(text: string, projectName: string): boolean {
  const project = projectName.trim().toLowerCase();
  if (!project) return false;
  return text.toLowerCase().includes(project);
}

/**
 * Put the project at the front of a title when the title does not already name it.
 * Titles that do not fit keep the project and clip the rest.
 */
export function withProjectMention(
  title: string,
  projectName: string | null | undefined,
  max = 120
): string {
  const trimmed = title.trim();
  const project = cleanProjectName(projectName);
  if (!project || !trimmed) return trimmed.slice(0, max);
  if (mentionsProject(trimmed, project)) return trimmed.slice(0, max);
  const next = `${project} — ${trimmed}`;
  if (next.length <= max) return next;
  const room = max - project.length - 3;
  if (room < 8) return `${project} — ${trimmed}`.slice(0, max);
  return `${project} — ${trimmed.slice(0, room - 1).trimEnd()}…`;
}
