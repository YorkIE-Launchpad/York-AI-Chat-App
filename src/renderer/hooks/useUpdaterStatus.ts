import { useCallback, useEffect, useState } from 'react';
import type { UpdaterStatus } from '../../shared/updater-types';

const IDLE: UpdaterStatus = {
  status: 'unsupported',
  currentVersion: '',
};

/** Match main UPDATE_INSTALL_QUIT_WATCHDOG_MS (+ buffer). */
const INSTALL_UI_WATCHDOG_MS = 50_000;

export function useUpdaterStatus() {
  const [status, setStatus] = useState<UpdaterStatus>(IDLE);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI?.updater;
    if (!api) return;

    void api
      .getStatus()
      .then(setStatus)
      .catch(() => undefined);
    return api.onStatus((next) => {
      setStatus(next);
      if (next.status === 'error') {
        setInstalling(false);
        if (next.message) {
          setInstallError(next.message);
        }
      }
    });
  }, []);

  const checkForUpdates = useCallback(async () => {
    const api = window.electronAPI?.updater;
    if (!api || checking) return;
    setChecking(true);
    setInstallError(null);
    try {
      const next = await api.check();
      setStatus(next);
    } catch {
      /* ignore */
    } finally {
      setChecking(false);
    }
  }, [checking]);

  const quitAndInstall = useCallback(async () => {
    const api = window.electronAPI?.updater;
    if (!api || installing) return;
    setInstalling(true);
    setInstallError(null);
    const uiWatchdog = window.setTimeout(() => {
      setInstalling(false);
    }, INSTALL_UI_WATCHDOG_MS);
    try {
      const result = await api.quitAndInstall();
      if (!result.success) {
        window.clearTimeout(uiWatchdog);
        setInstalling(false);
        const message = result.error || 'Could not restart to install the update.';
        setInstallError(message);
        void window.electronAPI?.logs
          ?.write?.('warn', '[UpdaterUI] quitAndInstall failed', { error: message, status })
          .catch(() => undefined);
        return;
      }
      void window.electronAPI?.logs
        ?.write?.('warn', '[UpdaterUI] quitAndInstall accepted', { status })
        .catch(() => undefined);
    } catch (error) {
      window.clearTimeout(uiWatchdog);
      setInstalling(false);
      const message = error instanceof Error ? error.message : 'Could not restart to install the update.';
      setInstallError(message);
    }
  }, [installing, status]);

  return {
    status,
    checking,
    installing,
    installError,
    checkForUpdates,
    quitAndInstall,
  };
}
