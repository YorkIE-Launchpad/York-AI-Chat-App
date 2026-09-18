import type {
  CognitoCaller,
  SharedDocAccess,
  SharedDocPermission,
  SharedDocRecord,
} from './types.js';

function normalizePrincipal(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveCallerFromPayload(payload: Record<string, unknown>): CognitoCaller | null {
  const sub = payload.sub;
  if (typeof sub !== 'string' || !sub.trim()) return null;
  const email =
    typeof payload.email === 'string' && payload.email.trim()
      ? payload.email.trim().toLowerCase()
      : undefined;
  return { sub: sub.trim(), email };
}

export function getDocAccess(doc: SharedDocRecord, caller: CognitoCaller): SharedDocAccess | null {
  if (doc.ownerSub === caller.sub) return 'owner';

  const principals = new Set<string>();
  principals.add(normalizePrincipal(caller.sub));
  if (caller.email) principals.add(normalizePrincipal(caller.email));

  for (const entry of doc.acl) {
    const p = normalizePrincipal(entry.principal);
    if (principals.has(p)) {
      return entry.permission;
    }
  }
  return null;
}

export function canView(access: SharedDocAccess | null): boolean {
  return access === 'owner' || access === 'view' || access === 'edit';
}

export function canEdit(access: SharedDocAccess | null): boolean {
  return access === 'owner' || access === 'edit';
}

export function normalizePermission(value: unknown): SharedDocPermission | null {
  if (value === 'view' || value === 'edit') return value;
  return null;
}
