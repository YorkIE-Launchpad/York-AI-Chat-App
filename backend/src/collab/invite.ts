/**
 * Stateless collab invite JWTs (HMAC). No server-side room registry.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const INVITE_TYP = 'york-collab-invite';

export interface CollabInvitePayload {
  roomId: string;
  iat: number;
  exp: number;
  typ: typeof INVITE_TYP;
}

function getInviteSecret(): string {
  const fromEnv =
    process.env.COLLAB_INVITE_SECRET?.trim() ||
    process.env.ZOOM_WEBHOOK_SECRET_TOKEN?.trim() ||
    process.env.AWS_COGNITO_APP_CLIENT_ID?.trim() ||
    '';
  if (fromEnv) return fromEnv;
  // Dev fallback — production should set COLLAB_INVITE_SECRET.
  return 'york-ie-collab-dev-secret';
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function signHs256(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

export function signCollabInvite(
  roomId: string,
  options?: { ttlSec?: number; nowSec?: number }
): string {
  const trimmed = roomId.trim();
  if (!trimmed) {
    throw new Error('roomId is required');
  }
  const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
  const ttlSec = options?.ttlSec ?? DEFAULT_TTL_SEC;
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: CollabInvitePayload = {
    roomId: trimmed,
    iat: nowSec,
    exp: nowSec + ttlSec,
    typ: INVITE_TYP,
  };
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = signHs256(signingInput, getInviteSecret());
  return `${signingInput}.${sig}`;
}

export type VerifyInviteResult =
  | { ok: true; payload: CollabInvitePayload }
  | { ok: false; error: string };

export function verifyCollabInvite(
  token: string,
  expectedRoomId?: string,
  options?: { nowSec?: number }
): VerifyInviteResult {
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

  let payload: CollabInvitePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as CollabInvitePayload;
  } catch {
    return { ok: false, error: 'Invalid invite payload' };
  }

  if (payload.typ !== INVITE_TYP) {
    return { ok: false, error: 'Not a collab invite token' };
  }
  if (typeof payload.roomId !== 'string' || !payload.roomId.trim()) {
    return { ok: false, error: 'Invite missing roomId' };
  }
  if (typeof payload.exp !== 'number') {
    return { ok: false, error: 'Invite missing exp' };
  }

  const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) {
    return { ok: false, error: 'Invite expired' };
  }

  if (expectedRoomId && payload.roomId !== expectedRoomId.trim()) {
    return { ok: false, error: 'Invite roomId mismatch' };
  }

  return { ok: true, payload };
}
