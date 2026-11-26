/**
 * Hub directory search for inviting teammates into a brainstorm.
 */
import { authConfig } from '../../shared/auth-config';
import type { BrainstormPerson } from '../../shared/brainstorm-types';
import { hubHttpRequest } from '../auth/hub-http';
import { getCurrentSession } from '../auth/session';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function personName(row: Record<string, unknown>): string {
  const direct = typeof row.name === 'string' ? row.name.trim() : '';
  if (direct) return direct;
  const first = typeof row.first_name === 'string' ? row.first_name.trim() : '';
  const last = typeof row.last_name === 'string' ? row.last_name.trim() : '';
  return [first, last].filter(Boolean).join(' ').trim();
}

function personTitle(row: Record<string, unknown>): string | null {
  const designation = asRecord(row.designation);
  const fromDesignation =
    designation && typeof designation.name === 'string' ? designation.name.trim() : '';
  if (fromDesignation) return fromDesignation;
  return typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null;
}

export function peopleFromDirectoryBody(body: unknown): BrainstormPerson[] {
  const root = asRecord(body);
  const data = root && Array.isArray(root.data) ? root.data : Array.isArray(body) ? body : [];
  const people: BrainstormPerson[] = [];
  for (const entry of data) {
    const row = asRecord(entry);
    if (!row) continue;
    const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
    const name = personName(row);
    if (!email || !name) continue;
    const image =
      (typeof row.profile_pic === 'string' && row.profile_pic.trim()) ||
      (typeof row.profilePic === 'string' && row.profilePic.trim()) ||
      null;
    people.push({ email, name, title: personTitle(row), image });
    if (people.length >= 8) break;
  }
  return people;
}

export async function searchHubPeople(query: string): Promise<BrainstormPerson[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const token = (getCurrentSession()?.accessToken || getCurrentSession()?.idToken || '').trim();
  if (!token) return [];
  const url = new URL(`${authConfig.hubApiUrl.replace(/\/+$/, '')}/api/users/directory`);
  url.searchParams.set('search', q);
  url.searchParams.set('limit', '8');
  url.searchParams.set('account_status', 'ACTIVE');
  const res = await hubHttpRequest(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
  if (!res.ok) return [];
  return peopleFromDirectoryBody(await res.json<unknown>());
}
