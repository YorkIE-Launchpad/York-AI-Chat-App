import { resolveBackendUrl } from '../../shared/backend-config';
import { YORK_APP_VERSION_HEADER } from '../../shared/client-version';
import type {
  SharedDocKind,
  SharedDocPermission,
  SharedDocWithAccess,
} from '../../shared/shared-docs/types';
import { getBackendAuthHeaders } from '../config/backend-auth';

function backendBase(): string {
  return resolveBackendUrl().replace(/\/$/, '');
}

async function backendJson<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const headers = await getBackendAuthHeaders();
  const res = await fetch(`${backendBase()}${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text };
    }
  }
  if (!res.ok) {
    const err =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`;
    const error = new Error(err) as Error & { status?: number; body?: unknown };
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json as T;
}

export async function createSharedDocInvite(input: {
  docId: string;
  s3Key: string;
  title: string;
  kind: SharedDocKind;
  contentType: string;
  permission: SharedDocPermission;
  ttlSec?: number;
}): Promise<{ docId: string; permission: SharedDocPermission; inviteToken: string }> {
  return backendJson('/share/docs/invite', {
    method: 'POST',
    body: input,
  });
}

export async function joinSharedDoc(inviteToken: string): Promise<SharedDocWithAccess> {
  return backendJson<SharedDocWithAccess>('/share/docs/join', {
    method: 'POST',
    body: { inviteToken },
  });
}

/** Exported for tests — version header name. */
export { YORK_APP_VERSION_HEADER };
