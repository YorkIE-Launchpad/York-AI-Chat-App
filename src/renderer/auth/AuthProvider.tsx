import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AuthStatusResponse, AuthUser } from '../../shared/auth-types';
import { AuthContext } from './AuthContext';
import {
  clearAuthLocalStorage,
  readStoredUser,
  sanitizeUserForStorage,
  writeAuthToLocalStorage,
} from './auth-storage';

type AuthApi = NonNullable<typeof window.electronAPI>['auth'];

function applyStatusToState(status: AuthStatusResponse): AuthUser | null {
  const user = status.user ? sanitizeUserForStorage(status.user) : null;
  if (user && status.tokens) {
    writeAuthToLocalStorage(
      {
        token: status.tokens.token,
        accessToken: status.tokens.accessToken,
        refreshToken: status.tokens.refreshToken,
      },
      user
    );
    return user;
  }
  if (!user) {
    clearAuthLocalStorage();
  }
  return user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const authApi = typeof window !== 'undefined' ? window.electronAPI?.auth : undefined;

  const clearAuth = useCallback(() => {
    clearAuthLocalStorage();
    setUser(null);
  }, []);

  const syncFromMain = useCallback(async (api: AuthApi) => {
    const status = await api.getStatus();
    const nextUser = applyStatusToState(status);
    setUser(nextUser);
    if (nextUser) {
      const me = await api.me();
      if (me.success && me.user) {
        const synced = sanitizeUserForStorage(me.user);
        if (synced) {
          writeAuthToLocalStorage(
            status.tokens
              ? {
                  token: status.tokens.token,
                  accessToken: status.tokens.accessToken,
                  refreshToken: status.tokens.refreshToken,
                }
              : null,
            synced
          );
          setUser(synced);
        }
      }
    }
  }, []);

  const checkAuth = useCallback(async () => {
    if (!authApi) {
      setLoading(false);
      return;
    }
    await syncFromMain(authApi);
  }, [authApi, syncFromMain]);

  const logout = useCallback(async () => {
    if (!authApi) {
      clearAuth();
      return;
    }
    await authApi.logout();
    clearAuth();
  }, [authApi, clearAuth]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!authApi) {
        const stored = readStoredUser();
        if (!cancelled) {
          setUser(stored);
          setLoading(false);
        }
        return;
      }
      try {
        await syncFromMain(authApi);
      } catch {
        clearAuth();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authApi, clearAuth, syncFromMain]);

  useEffect(() => {
    if (!authApi) return;
    const unsubscribe = authApi.onChanged((status) => {
      const nextUser = applyStatusToState(status);
      setUser(nextUser);
      void authApi.me().then((me) => {
        if (me.success && me.user) {
          const synced = sanitizeUserForStorage(me.user);
          if (synced) setUser(synced);
        }
      });
    });
    return unsubscribe;
  }, [authApi]);

  return (
    <AuthContext.Provider value={{ user, loading, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}
