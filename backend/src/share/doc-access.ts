import type {
  CognitoCaller,
  SharedDocAccess,
  SharedDocPermission,
  SharedDocRecord,
  SharedDocWithAccess,
} from './types.js';
import type { DocInvitePayload } from './doc-invite.js';

export function resolveCallerFromPayload(payload: Record<string, unknown>): CognitoCaller | null {
  const sub = payload.sub;
  if (typeof sub !== 'string' || !sub.trim()) return null;
  const email =
    typeof payload.email === 'string' && payload.email.trim()
      ? payload.email.trim().toLowerCase()
      : undefined;
  return { sub: sub.trim(), email };
}

export function accessForCaller(payload: DocInvitePayload, caller: CognitoCaller): SharedDocAccess {
  if (payload.ownerSub === caller.sub) return 'owner';
  return payload.permission;
}

export function docFromInvitePayload(
  payload: DocInvitePayload,
  permission: SharedDocAccess
): SharedDocWithAccess {
  return {
    id: payload.docId,
    ownerSub: payload.ownerSub,
    ownerEmail: payload.ownerEmail,
    title: payload.title,
    kind: payload.kind,
    s3Key: payload.s3Key,
    s3UpdatedAt: '',
    contentType: payload.contentType,
    permission,
  };
}

export function normalizePermission(value: unknown): SharedDocPermission | null {
  if (value === 'view' || value === 'edit') return value;
  return null;
}

export function canView(access: SharedDocAccess | null): boolean {
  return access === 'owner' || access === 'view' || access === 'edit';
}

export function canEdit(access: SharedDocAccess | null): boolean {
  return access === 'owner' || access === 'edit';
}