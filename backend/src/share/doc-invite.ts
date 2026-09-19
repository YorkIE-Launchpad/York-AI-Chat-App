/**
 * Stateless shared-document invite JWTs (HMAC).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SharedDocKind, SharedDocPermission } from './types.js';

const DEFAULT_TTL_SEC = 7 * 24 * 60 * 60;
const INVITE_TYP = 'york-shared-doc-invite';

export interface DocInviteDocument {
  docId: string;
  s3Key: string;
  title: string;
  kind: SharedDocKind;
  contentType: string;
  ownerSub: string;
  ownerEmail: string;
}

export interface DocInvitePayload extends DocInviteDocument {
  permission: SharedDocPermission;
  iat: number;
  exp: number;
  typ: typeof INVITE_TYP;
}

function getInviteSecret(): string {
  const fromEnv =
    process.env.SHARED_DOC_INVITE_SECRET?.trim() ||
    process.env.COLLAB_INVITE_SECRET?.trim() ||
    process.env.ZOOM_WEBHOOK_SECRET_TOKEN?.trim() ||
    process.env.AWS_COGNITO_APP_CLIENT_ID?.trim() ||
    '';
  if (fromEnv) return fromEnv;
  return 'york-ie-shared-doc-dev-secret';
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function signHs256(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

export function signDocInvite(
  doc: DocInviteDocument,
  permission: SharedDocPermission,
  options?: { ttlSec?: number; nowSec?: number }
): string {
  const docId = doc.docId.trim();
  const s3Key = doc.s3Key.trim();
  if (!docId) throw new Error('docId is required');
  if (!s3Key) throw new Error('s3Key is required');
  if (permission !== 'view' && permission !== 'edit') {
    throw new Error('permission must be view or edit');
  }

  const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
  const ttlSec = options?.ttlSec ?? DEFAULT_TTL_SEC;
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: DocInvitePayload = {
    docId,
    s3Key,
    title: doc.title.trim().slice(0, 500),
    kind: doc.kind,
    contentType: doc.contentType.trim() || 'text/plain',
    ownerSub: doc.ownerSub.trim(),
    ownerEmail: doc.ownerEmail.trim().toLowerCase(),
    permission,
    iat: nowSec,
    exp: nowSec + ttlSec,
    typ: INVITE_TYP,
  };
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = signHs256(signingInput, getInviteSecret());
  return `${signingInput}.${sig}`;
}

export type VerifyDocInviteResult =
  | { ok: true; payload: DocInvitePayload }
  | { ok: false; error: string };

export function verifyDocInvite(
  token: string,
  expectedDocId?: string,
  options?: { nowSec?: number }
): VerifyDocInviteResult {
  const raw = token.trim();
  if (!raw) return { ok: false, error: 'Invite token required' };

  const parts = raw.split('.');
  if (parts.length !== 3) return { ok: false, error: 'Malformed invite token' };

  const [headerB64, payloadB64, sig] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = signHs256(signingInput, getInviteSecret());

  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, error: 'Invalid invite signature' };
    }
  } catch {
    return { ok: false, error: 'Invalid invite signature' };
  }

  let payload: DocInvitePayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as DocInvitePayload;
  } catch {
    return { ok: false, error: 'Invalid invite payload' };
  }

  if (payload.typ !== INVITE_TYP) {
    return { ok: false, error: 'Not a shared-doc invite token' };
  }
  if (typeof payload.docId !== 'string' || !payload.docId.trim()) {
    return { ok: false, error: 'Invite missing docId' };
  }
  if (typeof payload.s3Key !== 'string' || !payload.s3Key.trim()) {
    return { ok: false, error: 'Invite missing s3Key' };
  }
  if (typeof payload.title !== 'string' || !payload.title.trim()) {
    return { ok: false, error: 'Invite missing title' };
  }
  if (payload.kind !== 'html' && payload.kind !== 'markdown') {
    return { ok: false, error: 'Invite missing kind' };
  }
  if (typeof payload.contentType !== 'string' || !payload.contentType.trim()) {
    return { ok: false, error: 'Invite missing contentType' };
  }
  if (typeof payload.ownerSub !== 'string' || !payload.ownerSub.trim()) {
    return { ok: false, error: 'Invite missing ownerSub' };
  }
  if (payload.permission !== 'view' && payload.permission !== 'edit') {
    return { ok: false, error: 'Invite missing permission' };
  }
  if (typeof payload.exp !== 'number') {
    return { ok: false, error: 'Invite missing exp' };
  }

  const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) {
    return { ok: false, error: 'Invite expired' };
  }

  if (expectedDocId && payload.docId !== expectedDocId.trim()) {
    return { ok: false, error: 'Invite docId mismatch' };
  }

  return { ok: true, payload };
}
