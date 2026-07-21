import { getDatabase } from '../db/database';
import { authConfig } from '../../shared/auth-config';
import type { AuthUser, AuthUserRole } from '../../shared/auth-types';
import { getEmailFromPayload, type CognitoJwtPayload } from './cognito';
import { normalizeProfileImageUrl } from './hub-parse';

export interface DbUserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  image: string | null;
  created_at: number;
  updated_at: number;
}

function normalizeRole(role: string): AuthUserRole {
  return role === 'admin' ? 'admin' : 'manager';
}

export function toAuthUser(row: DbUserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: normalizeRole(row.role),
    image: row.image,
  };
}

export function findUserById(id: number): AuthUser | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUserRow | undefined;
  return row ? toAuthUser(row) : null;
}

export function findUserByEmail(email: string): AuthUser | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as DbUserRow | undefined;
  return row ? toAuthUser(row) : null;
}

export function updateUserImage(userId: number, image: string | null): AuthUser | null {
  const normalized = image?.trim() ? normalizeProfileImageUrl(image.trim()) : null;
  if (!normalized) return findUserById(userId);
  const db = getDatabase();
  const now = Date.now();
  db.prepare('UPDATE users SET image = ?, updated_at = ? WHERE id = ?').run(
    normalized,
    now,
    userId
  );
  return findUserById(userId);
}

function resolveProfilePicture(
  payload: CognitoJwtPayload,
  fallbackImage?: string | null
): string | null {
  const fromJwt =
    typeof payload.picture === 'string' && payload.picture.trim() ? payload.picture.trim() : null;
  const fromHub = fallbackImage?.trim() ? normalizeProfileImageUrl(fallbackImage.trim()) : null;
  return fromJwt ?? fromHub;
}

export function findOrCreateUserFromCognitoPayload(
  payload: CognitoJwtPayload,
  role: AuthUserRole = 'manager',
  options?: {
    fallbackEmail?: string | null;
    fallbackName?: string | null;
    fallbackImage?: string | null;
  }
): { user: AuthUser | null; error?: string } {
  const email = getEmailFromPayload(payload) ?? options?.fallbackEmail?.trim() ?? null;
  if (!email) {
    return {
      user: null,
      error:
        'No email on Cognito token (access tokens often omit email). Hub profile had no email either.',
    };
  }

  const allowedDomain = authConfig.authAllowedDomain?.trim();
  if (allowedDomain && !email.endsWith(allowedDomain)) {
    return {
      user: null,
      error: `Email ${email} is not allowed for AUTH_ALLOWED_DOMAIN=${allowedDomain}`,
    };
  }

  const name =
    (typeof payload.name === 'string' && payload.name) ||
    (typeof payload.given_name === 'string' && payload.given_name) ||
    options?.fallbackName?.trim() ||
    email.split('@')[0];
  const picture = resolveProfilePicture(payload, options?.fallbackImage);

  const db = getDatabase();
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
    | DbUserRow
    | undefined;

  if (!existing) {
    const result = db
      .prepare(
        `INSERT INTO users (email, name, role, image, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(email, name, role, picture, now, now);
    const id = Number(result.lastInsertRowid);
    const created = findUserById(id);
    return created ? { user: created } : { user: null, error: 'Failed to create user row' };
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  if (name && name !== existing.name) {
    updates.push('name = ?');
    values.push(name);
  }
  if (picture !== null && picture !== existing.image) {
    updates.push('image = ?');
    values.push(picture);
  }
  if (updates.length > 0) {
    updates.push('updated_at = ?');
    values.push(now);
    values.push(existing.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  return { user: findUserById(existing.id) };
}
