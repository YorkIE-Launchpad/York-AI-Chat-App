import { useCallback, useEffect, useState } from 'react';
import type { UpdaterStatus } from '../../shared/updater-types';

const IDLE: UpdaterStatus = {
  status: 'unsupported',
  currentVersion: '',
};

export function useUpdaterStatus() {
  const [status, setStatus] = useState<UpdaterStatus>(IDLE);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const api = window.electronAPI?.updater;
    if (!api) return;

    void api
      .getStatus()
      .then(setStatus)
      .catch(() => undefined);
    return api.onStatus(setStatus);
  }, []);

  const checkForUpdates = useCallback(async () => {
    const api = window.electronAPI?.updater;
    if (!api || checking) return;
    setChecking(true);
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
    try {
      const result = await api.quitAndInstall();
      if (!result.success) {
        setInstalling(false);
      }
    } catch {
      setInstalling(false);
    }
  }, [installing]);

  return {
    status,
    checking,
    installing,
    checkForUpdates,
    quitAndInstall,
  };
}
