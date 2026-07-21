import type { AuthUser } from '../../shared/auth-types';

export const AUTH_STORAGE_KEYS = {
  token: 'token',
  accessToken: 'access_token',
  refreshToken: 'cognito_refresh_token',
  user: 'user',
} as const;

export function sanitizeUserForStorage(user: AuthUser | null): AuthUser | null {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
  };
}

export function readStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEYS.user);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    return sanitizeUserForStorage(parsed);
  } catch {
    return null;
  }
}

export function writeAuthToLocalStorage(
  tokens: {
    token: string;
    accessToken: string;
    refreshToken: string;
  } | null,
  user: AuthUser | null
): void {
  if (!tokens || !user) {
    localStorage.removeItem(AUTH_STORAGE_KEYS.token);
    localStorage.removeItem(AUTH_STORAGE_KEYS.accessToken);
    localStorage.removeItem(AUTH_STORAGE_KEYS.refreshToken);
    localStorage.removeItem(AUTH_STORAGE_KEYS.user);
    return;
  }
  localStorage.setItem(AUTH_STORAGE_KEYS.token, tokens.token);
  localStorage.setItem(AUTH_STORAGE_KEYS.accessToken, tokens.accessToken);
  localStorage.setItem(AUTH_STORAGE_KEYS.refreshToken, tokens.refreshToken);
  const safeUser = sanitizeUserForStorage(user);
  if (safeUser) {
    localStorage.setItem(AUTH_STORAGE_KEYS.user, JSON.stringify(safeUser));
  }
}

export function clearAuthLocalStorage(): void {
  writeAuthToLocalStorage(null, null);
}
