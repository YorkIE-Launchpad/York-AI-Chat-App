/**
 * Best-effort extraction of Hub job/org fields from /me-style JSON bodies.
 * Pure — safe to unit test without network.
 */

export interface ExtractedHubProfileFields {
  title?: string | null;
  functionName?: string | null;
  squad?: string | null;
  department?: string | null;
  name?: string | null;
  email?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value != null && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      const nestedName =
        (typeof nested.name === 'string' && nested.name.trim()) ||
        (typeof nested.title === 'string' && nested.title.trim()) ||
        (typeof nested.label === 'string' && nested.label.trim()) ||
        null;
      if (nestedName) return nestedName;
    }
  }
  return null;
}

function collectRecords(body: unknown): Record<string, unknown>[] {
  const root = asRecord(body);
  if (!root) return [];
  const data = asRecord(root.data) ?? root;
  const records: Record<string, unknown>[] = [data];
  for (const key of ['employeeData', 'employee', 'user', 'profile', 'me']) {
    const nested = asRecord(data[key]);
    if (nested) records.push(nested);
  }
  if (root !== data) {
    for (const key of ['employeeData', 'employee', 'user', 'profile']) {
      const nested = asRecord(root[key]);
      if (nested) records.push(nested);
    }
  }
  return records;
}

const TITLE_KEYS = [
  'designation',
  'title',
  'job_title',
  'jobTitle',
  'role_title',
  'roleTitle',
  'position',
  'position_title',
  'positionTitle',
];

const FUNCTION_KEYS = [
  'function',
  'function_name',
  'functionName',
  'function_title',
  'org_function',
];

const SQUAD_KEYS = ['squad', 'squad_name', 'squadName', 'team', 'team_name', 'teamName'];

const DEPARTMENT_KEYS = ['department', 'department_name', 'departmentName', 'dept'];

const NAME_KEYS = ['name', 'full_name', 'fullName', 'display_name', 'displayName'];

const EMAIL_KEYS = ['email', 'work_email', 'workEmail'];

/**
 * Extract title / function / squad / department (and optional name/email) from a Hub API body.
 */
export function extractHubProfileFields(body: unknown): ExtractedHubProfileFields {
  const records = collectRecords(body);
  let title: string | null = null;
  let functionName: string | null = null;
  let squad: string | null = null;
  let department: string | null = null;
  let name: string | null = null;
  let email: string | null = null;

  for (const record of records) {
    title = title ?? pickString(record, TITLE_KEYS);
    functionName = functionName ?? pickString(record, FUNCTION_KEYS);
    squad = squad ?? pickString(record, SQUAD_KEYS);
    department = department ?? pickString(record, DEPARTMENT_KEYS);
    name = name ?? pickString(record, NAME_KEYS);
    if (!name) {
      const first = pickString(record, ['first_name', 'firstName']);
      const last = pickString(record, ['last_name', 'lastName']);
      if (first || last) {
        name = [first, last].filter(Boolean).join(' ').trim() || null;
      }
    }
    email = email ?? pickString(record, EMAIL_KEYS);
  }

  // Prefer first_name + last_name composition over a bare "name" that is only email-ish
  return { title, functionName, squad, department, name, email };
}

export function mergeHubProfileFields(
  base: ExtractedHubProfileFields,
  next: ExtractedHubProfileFields
): ExtractedHubProfileFields {
  return {
    title: next.title ?? base.title ?? null,
    functionName: next.functionName ?? base.functionName ?? null,
    squad: next.squad ?? base.squad ?? null,
    department: next.department ?? base.department ?? null,
    name: next.name ?? base.name ?? null,
    email: next.email ?? base.email ?? null,
  };
}
