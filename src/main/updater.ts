/**
 * macOS auto-update via electron-updater + S3 generic feed.
 * Downloads in the background; install is user-triggered via quitAndInstall.
 */
import { app, BrowserWindow } from 'electron';
import type { UpdaterStatus, UpdaterStatusKind } from '../shared/updater-types';

export const UPDATE_FEED_URL =
  'https://york-internal-apps.s3.ap-south-1.amazonaws.com/york-workos/latest';

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const UPDATE_CHECK_INITIAL_DELAY_MS = 8_000;

export function shouldEnableAutoUpdater(opts: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): boolean {
  return opts.isPackaged && opts.platform === 'darwin';
}

type StatusListener = (status: UpdaterStatus) => void;

let currentStatus: UpdaterStatus = {
  status: 'unsupported',
  currentVersion: '0.0.0',
};

let installingUpdate = false;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let autoUpdaterInstance: typeof import('electron-updater').autoUpdater | null = null;

const listeners = new Set<StatusListener>();

function getCurrentVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

function setStatus(partial: Partial<UpdaterStatus> & { status: UpdaterStatusKind }): void {
  currentStatus = {
    ...currentStatus,
    currentVersion: partial.currentVersion ?? getCurrentVersion(),
    ...partial,
  };
  for (const listener of listeners) {
    try {
      listener(currentStatus);
    } catch {
      /* ignore listener errors */
    }
  }
  broadcastToWindows(currentStatus);
}

function broadcastToWindows(status: UpdaterStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('updater:status', status);
    } catch {
      /* ignore */
    }
  }
}

export function getUpdaterStatus(): UpdaterStatus {
  return { ...currentStatus };
}

export function isInstallingUpdate(): boolean {
  return installingUpdate;
}

export function onUpdaterStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function checkForAppUpdates(): Promise<UpdaterStatus> {
  if (!autoUpdaterInstance) {
    return getUpdaterStatus();
  }
  try {
    setStatus({ status: 'checking', message: undefined });
    await autoUpdaterInstance.checkForUpdates();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus({ status: 'error', message });
  }
  return getUpdaterStatus();
}

export function quitAndInstallUpdate(): { success: boolean; error?: string } {
  if (!autoUpdaterInstance) {
    return { success: false, error: 'Updater is not available' };
  }
  if (currentStatus.status !== 'ready') {
    return { success: false, error: 'No update is ready to install' };
  }
  installingUpdate = true;
  try {
    // isSilent=false, isForceRunAfter=true → relaunch after replace
    autoUpdaterInstance.quitAndInstall(false, true);
    return { success: true };
  } catch (err) {
    installingUpdate = false;
    const message = err instanceof Error ? err.message : String(err);
    setStatus({ status: 'error', message });
    return { success: false, error: message };
  }
}

/**
 * Start background update checks. No-op when not packaged macOS.
 */
export async function startAutoUpdater(
  log: (...args: unknown[]) => void = console.log
): Promise<void> {
  if (started) return;
  started = true;

  const enabled = shouldEnableAutoUpdater({
    isPackaged: app.isPackaged,
    platform: process.platform,
  });

  currentStatus = {
    status: enabled ? 'idle' : 'unsupported',
    currentVersion: getCurrentVersion(),
  };

  if (!enabled) {
    log('[AutoUpdater] Skipped (packaged macOS only)');
    return;
  }

  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdaterInstance = autoUpdater;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: UPDATE_FEED_URL,
    });

    autoUpdater.on('checking-for-update', () => {
      setStatus({ status: 'checking', message: undefined, percent: undefined });
    });

    autoUpdater.on('update-available', (info) => {
      setStatus({
        status: 'available',
        version: info.version,
        message: undefined,
        percent: 0,
      });
      log('[AutoUpdater] Update available:', info.version);
    });

    autoUpdater.on('update-not-available', () => {
      setStatus({
        status: 'idle',
        version: undefined,
        percent: undefined,
        message: undefined,
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      setStatus({
        status: 'downloading',
        percent: Math.round(progress.percent),
        message: undefined,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      setStatus({
        status: 'ready',
        version: info.version,
        percent: 100,
        message: undefined,
      });
      log('[AutoUpdater] Update downloaded:', info.version);
    });

    autoUpdater.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log('[AutoUpdater] Error:', message);
      setStatus({ status: 'error', message });
    });

    const runCheck = () => {
      void checkForAppUpdates().catch((err: unknown) => {
        log('[AutoUpdater] Check failed:', err);
      });
    };

    setTimeout(runCheck, UPDATE_CHECK_INITIAL_DELAY_MS);
    checkTimer = setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS);
    log('[AutoUpdater] Started — feed:', UPDATE_FEED_URL);
  } catch (err) {
    log('[AutoUpdater] Failed to load electron-updater:', err);
    setStatus({
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function stopAutoUpdater(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
