import type { BrowserWindow } from 'electron';
import type { AuthSessionPayload, AuthStatusResponse, AuthUser } from '../../shared/auth-types';
import { authStore } from './auth-store';
import { verifyCognitoToken, verifyCognitoTokenDetailed } from './cognito';
import { findOrCreateUserFromCognitoPayload, findUserById, updateUserImage } from './user-service';
import type { ParsedHubAuth } from './hub-parse';
import {
  getHubProfileEmail,
  getHubProfileImage,
  getHubProfileName,
  normalizeProfileImageUrl,
} from './hub-parse';
import { fetchHubProfileImage } from './hub-profile-image';
import { logWarn } from '../utils/logger';
import {
  hubLogoutRequest,
  hubRefreshTokens,
  runHubGoogleOAuthFlow,
  exchangeHubAuthCode,
  initHubOAuthRelay,
} from './hub-oauth';

export const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';

export class AuthRequiredError extends Error {
  code = AUTH_REQUIRED_CODE;
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

const PROACTIVE_REFRESH_BUFFER_SEC = 5 * 60;

let session: AuthSessionPayload | null = null;
let notifyRenderer: ((win: BrowserWindow | null) => void) | null = null;

export function setAuthRendererNotifier(fn: (win: BrowserWindow | null) => void): void {
  notifyRenderer = fn;
}

function emitAuthChanged(win: BrowserWindow | null): void {
  notifyRenderer?.(win);
}

function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function isTokenExpired(token: string, bufferSec = 60): boolean {
  const exp = decodeJwtExp(token);
  if (!exp) return true;
  const now = Math.floor(Date.now() / 1000);
  return exp <= now + bufferSec;
}

function isTokenExpiringSoon(token: string, bufferSec = PROACTIVE_REFRESH_BUFFER_SEC): boolean {
  const exp = decodeJwtExp(token);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp <= now + bufferSec;
}

function persistSession(payload: AuthSessionPayload): void {
  authStore.save({
    idToken: payload.idToken,
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    userJson: JSON.stringify(payload.user),
  });
}

function clearPersistedSession(): void {
  authStore.clear();
}

export function getCurrentSession(): AuthSessionPayload | null {
  return session;
}

async function ensureUserProfileImage(user: AuthUser, accessToken: string): Promise<AuthUser> {
  if (user.image?.trim()) {
    const normalized = normalizeProfileImageUrl(user.image);
    if (normalized !== user.image) {
      return updateUserImage(user.id, normalized) ?? user;
    }
    return user;
  }

  const token = accessToken.trim() || session?.idToken?.trim() || '';
  if (!token) return user;

  const fromHub = await fetchHubProfileImage(token);
  if (!fromHub) return user;
  return updateUserImage(user.id, fromHub) ?? user;
}

export function isAuthenticated(): boolean {
  return session != null && !isTokenExpired(session.idToken);
}

async function establishSessionFromTokens(
  idToken: string,
  accessToken: string,
  refreshToken: string,
  hubParsed?: ParsedHubAuth | null,
  extraFallback?: { email?: string; name?: string }
): Promise<AuthSessionPayload> {
  const hubEmail = getHubProfileEmail(hubParsed ?? null) ?? extraFallback?.email ?? null;
  const hubName = getHubProfileName(hubParsed ?? null) ?? extraFallback?.name ?? null;
  const hubImage = getHubProfileImage(hubParsed ?? null);

  const rawCandidates = [idToken, accessToken].filter(Boolean);
  const candidates = [...new Set(rawCandidates)];
  let user: AuthUser | null = null;
  let launchpadToken = idToken || accessToken;
  const failureReasons: string[] = [];

  for (const candidate of candidates) {
    const verified = await verifyCognitoTokenDetailed(candidate);
    if (!verified.ok) {
      failureReasons.push(verified.error);
      continue;
    }
    const { user: dbUser, error } = findOrCreateUserFromCognitoPayload(
      verified.payload,
      'manager',
      { fallbackEmail: hubEmail, fallbackName: hubName, fallbackImage: hubImage }
    );
    if (dbUser) {
      user = dbUser;
      launchpadToken = candidate;
      break;
    }
    if (error) failureReasons.push(error);
  }

  if (!user) {
    const detail = failureReasons.length ? failureReasons.join(' ') : 'Unknown error';
    logWarn('[Auth] establishSessionFromTokens failed:', detail);
    throw new Error(detail);
  }

  user = await ensureUserProfileImage(user, accessToken || launchpadToken);

  const next: AuthSessionPayload = {
    user,
    idToken: launchpadToken,
    accessToken: accessToken || launchpadToken,
    refreshToken: refreshToken || '',
  };
  session = next;
  persistSession(next);
  return next;
}

export async function restoreSessionFromStore(): Promise<AuthSessionPayload | null> {
  const stored = authStore.load();
  if (!stored) return null;
  try {
    const user = JSON.parse(stored.userJson) as AuthUser;
    if (!user?.email) {
      clearPersistedSession();
      return null;
    }
    session = {
      user,
      idToken: stored.idToken,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
    };
    if (isTokenExpired(stored.idToken)) {
      const refreshed = await tryRefreshSession();
      if (!refreshed) {
        session = null;
        clearPersistedSession();
        return null;
      }
    } else {
      const synced = await syncMeFromToken();
      if (synced) session = synced;
    }
    return session;
  } catch {
    session = null;
    clearPersistedSession();
    return null;
  }
}

export async function syncMeFromToken(): Promise<AuthSessionPayload | null> {
  if (!session) return null;
  const payload = await verifyCognitoToken(session.idToken);
  if (!payload) return null;
  const { user: dbUser } = findOrCreateUserFromCognitoPayload(payload, 'manager');
  if (!dbUser) return null;
  const withImage = await ensureUserProfileImage(dbUser, session.accessToken || session.idToken);
  session = { ...session, user: withImage };
  persistSession(session);
  return session;
}

export function getAuthStatus(): AuthStatusResponse {
  if (!session) {
    return { user: null, tokens: null };
  }
  return {
    user: session.user,
    tokens: {
      token: session.idToken,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    },
  };
}

export async function getMe(): Promise<{ user: AuthUser }> {
  const synced = await syncMeFromToken();
  if (!synced?.user) {
    throw new AuthRequiredError();
  }
  const fresh = findUserById(synced.user.id);
  if (!fresh) {
    throw new AuthRequiredError();
  }
  const withImage = await ensureUserProfileImage(fresh, synced.accessToken || synced.idToken);
  session = { ...synced, user: withImage };
  persistSession(session);
  return { user: withImage };
}

export async function tryRefreshSession(): Promise<boolean> {
  if (!session?.refreshToken || !session.user.email) return false;
  const refreshed = await hubRefreshTokens(session.refreshToken, session.user.email);
  if (!refreshed) return false;
  const idToken = refreshed.idToken ?? session.idToken;
  const accessToken = refreshed.accessToken ?? session.accessToken;
  const refreshToken = refreshed.refreshToken ?? session.refreshToken;
  await establishSessionFromTokens(idToken, accessToken, refreshToken, null, {
    email: session?.user.email,
    name: session?.user.name,
  });
  return true;
}

export async function ensureAuthenticatedSession(): Promise<AuthSessionPayload> {
  if (session && !isTokenExpired(session.idToken)) {
    if (isTokenExpiringSoon(session.idToken)) {
      await tryRefreshSession();
    }
    if (session && !isTokenExpired(session.idToken)) {
      return session;
    }
  }
  const restored = await restoreSessionFromStore();
  if (restored && !isTokenExpired(restored.idToken)) {
    return restored;
  }
  if (session && session.refreshToken) {
    const ok = await tryRefreshSession();
    if (ok && session) return session;
  }
  session = null;
  clearPersistedSession();
  throw new AuthRequiredError();
}

export async function startGoogleLogin(win: BrowserWindow | null): Promise<AuthStatusResponse> {
  const { parsed } = await runHubGoogleOAuthFlow();
  const idToken = (parsed.idToken || parsed.token || '').trim();
  const accessToken = (parsed.accessToken || parsed.token || '').trim();
  if (!idToken && !accessToken) {
    throw new Error('No token in callback response');
  }
  await establishSessionFromTokens(idToken, accessToken, parsed.refreshToken || '', parsed);
  await syncMeFromToken();
  emitAuthChanged(win);
  return getAuthStatus();
}

export async function completeOAuthFromHubCode(
  win: BrowserWindow | null,
  code: string,
  redirectUri: string
): Promise<AuthStatusResponse> {
  const parsed = await exchangeHubAuthCode(code, redirectUri);
  const idToken = parsed.idToken || parsed.token;
  const accessToken = parsed.accessToken || parsed.token;
  if (!idToken && !accessToken) {
    throw new Error('No token in callback response');
  }
  await establishSessionFromTokens(idToken, accessToken, parsed.refreshToken || '', parsed);
  await syncMeFromToken();
  emitAuthChanged(win);
  return getAuthStatus();
}

export async function logout(win: BrowserWindow | null): Promise<void> {
  if (session) {
    await hubLogoutRequest(session.accessToken || session.idToken, session.refreshToken);
  }
  session = null;
  clearPersistedSession();
  emitAuthChanged(win);
}

export async function refreshAuth(win: BrowserWindow | null): Promise<AuthStatusResponse> {
  const ok = await tryRefreshSession();
  if (!ok) {
    session = null;
    clearPersistedSession();
    throw new AuthRequiredError();
  }
  emitAuthChanged(win);
  return getAuthStatus();
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startAuthRefreshTimer(getWindow: () => BrowserWindow | null): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!session?.refreshToken) {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      return;
    }
    void (async () => {
      if (!session) return;
      if (
        isTokenExpired(session.idToken) ||
        isTokenExpiringSoon(session.idToken, PROACTIVE_REFRESH_BUFFER_SEC)
      ) {
        const ok = await tryRefreshSession();
        if (ok) emitAuthChanged(getWindow());
        else {
          session = null;
          clearPersistedSession();
          emitAuthChanged(getWindow());
        }
      }
    })();
  }, 60_000);
}

export function stopAuthRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export async function initAuth(getWindow: () => BrowserWindow | null): Promise<void> {
  initHubOAuthRelay();
  await restoreSessionFromStore();
  if (session?.refreshToken) {
    startAuthRefreshTimer(getWindow);
  }
}
