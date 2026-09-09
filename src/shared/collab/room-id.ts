/**
 * Shareable collab room IDs (human-pasteable). Not JWTs.
 * Capability model: knowing the roomId + Cognito auth is enough to join.
 */
import { randomBytes } from 'crypto';

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

/** Compact room id, e.g. `k7Qm2nXp4Rwa` */
export function createCollabRoomId(): string {
  return randomBytes(9).toString('base64url'); // 12 chars
}

export function isCollabRoomId(value: string): boolean {
  return ROOM_ID_RE.test(value.trim());
}

/**
 * Accept plain room ids, optional `york-collab:` prefix, or legacy invite JWTs.
 */
export function parseCollabRoomId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const withoutPrefix = raw.replace(/^york-collab:/i, '').trim();
  if (isCollabRoomId(withoutPrefix)) {
    return withoutPrefix;
  }

  // Legacy JWT invite: extract roomId from payload
  const parts = raw.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8')
      ) as { roomId?: unknown };
      if (typeof payload.roomId === 'string' && isCollabRoomId(payload.roomId)) {
        return payload.roomId.trim();
      }
    } catch {
      return null;
    }
  }

  return null;
}
