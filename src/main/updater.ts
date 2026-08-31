/**
 * macOS auto-update via electron-updater + S3 generic feed.
 * Downloads in the background; install is user-triggered via quitAndInstall.
 */
import { app, BrowserWindow } from 'electron';
import type { UpdaterStatus, UpdaterStatusKind } from '../shared/updater-types';

export const UPDATE_FEED_URL =
  'https://york-internal-apps.s3.ap-south-1.amazonaws.com/york-workos/latest';

/** Base cadence between background update checks (1 hour). */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const UPDATE_CHECK_INITIAL_DELAY_MS = 8_000;

/**
 * Random delay in [0, interval) so installs don't hit the feed in lockstep.
 * Combined with a fixed hourly interval after the first check, each install
 * settles on its own offset within the hour.
 */
export function nextUpdateCheckDelayMs(random: () => number = Math.random): number {
  return Math.floor(random() * UPDATE_CHECK_INTERVAL_MS);
}

/** Delay before re-checking the feed for a newer release after one is downloaded. */
export const READY_STATE_RECHECK_DELAY_MS = 3_000;

export function isVersionNewer(candidate: string, baseline: string): boolean {
  const parse = (version: string) => version.split('.').map((part) => parseInt(part, 10) || 0);
  const left = parse(candidate);
  const right = parse(baseline);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Keep "restart to update" UI when a downloaded build is still pending install. */
export function shouldPreserveReadyStatus(opts: {
  pendingDownloadVersion: string | null;
  currentVersion: string;
}): boolean {
  if (!opts.pendingDownloadVersion) return false;
  return isVersionNewer(opts.pendingDownloadVersion, opts.currentVersion);
}

export function shouldPreserveReadyOnNotAvailable(opts: {
  pendingDownloadVersion: string | null;
  currentVersion: string;
  feedVersion?: string;
}): boolean {
  if (!shouldPreserveReadyStatus(opts)) return false;
  // Feed may already match the downloaded build while a newer release exists;
  // keep ready UI and schedule another check instead of clearing to idle.
  if (opts.feedVersion && isVersionNewer(opts.feedVersion, opts.pendingDownloadVersion!)) {
    return false;
  }
  return true;
}

export function shouldPreserveReadyOnChecking(opts: {
  pendingDownloadVersion: string | null;
  currentVersion: string;
}): boolean {
  return shouldPreserveReadyStatus(opts);
}

export function shouldPreserveReadyOnError(opts: {
  pendingDownloadVersion: string | null;
  currentVersion: string;
}): boolean {
  return shouldPreserveReadyStatus(opts);
}

export function shouldEnableAutoUpdater(opts: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): boolean {
  return opts.isPackaged && opts.platform === 'darwin';
}

type ElectronUpdaterModule = {
  autoUpdater?: typeof import('electron-updater').autoUpdater;
  default?: {
    autoUpdater?: typeof import('electron-updater').autoUpdater;
  };
};

/**
 * Resolve autoUpdater across CJS/ESM interop.
 * Node's ESM import of electron-updater does not promote the lazy
 * `autoUpdater` getter to a named export — it lives on `default`.
 */
export function resolveAutoUpdater(
  mod: ElectronUpdaterModule
): typeof import('electron-updater').autoUpdater | null {
  return mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
}

type StatusListener = (status: UpdaterStatus) => void;

let currentStatus: UpdaterStatus = {
  status: 'unsupported',
  currentVersion: '0.0.0',
};

let installingUpdate = false;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let readyRecheckTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let autoUpdaterInstance: typeof import('electron-updater').autoUpdater | null = null;
/** Version downloaded to disk and awaiting user-triggered install. */
let pendingDownloadVersion: string | null = null;

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

function restoreReadyStatus(): void {
  if (!pendingDownloadVersion) return;
  setStatus({
    status: 'ready',
    version: pendingDownloadVersion,
    percent: 100,
    message: undefined,
  });
}

function scheduleRecheckForNewerRelease(
  runCheck: (background: boolean) => void,
  log: (...args: unknown[]) => void
): void {
  if (!pendingDownloadVersion) return;
  if (readyRecheckTimer) clearTimeout(readyRecheckTimer);
  readyRecheckTimer = setTimeout(() => {
    readyRecheckTimer = null;
    log('[AutoUpdater] Re-checking feed for newer release (pending:', pendingDownloadVersion, ')');
    runCheck(true);
  }, READY_STATE_RECHECK_DELAY_MS);
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

export async function checkForAppUpdates(opts?: { background?: boolean }): Promise<UpdaterStatus> {
  if (!autoUpdaterInstance) {
    return getUpdaterStatus();
  }
  const preserveReady =
    opts?.background &&
    shouldPreserveReadyOnChecking({
      pendingDownloadVersion,
      currentVersion: getCurrentVersion(),
    });
  try {
    if (!preserveReady) {
      setStatus({ status: 'checking', message: undefined });
    }
    await autoUpdaterInstance.checkForUpdates();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      shouldPreserveReadyOnError({
        pendingDownloadVersion,
        currentVersion: getCurrentVersion(),
      })
    ) {
      restoreReadyStatus();
    } else {
      setStatus({ status: 'error', message });
    }
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
    const updaterMod = (await import('electron-updater')) as ElectronUpdaterModule;
    const autoUpdater = resolveAutoUpdater(updaterMod);
    if (!autoUpdater) {
      throw new Error('electron-updater autoUpdater export is unavailable (CJS/ESM interop)');
    }
    autoUpdaterInstance = autoUpdater;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: UPDATE_FEED_URL,
    });

    const runCheck = (background = false) => {
      void checkForAppUpdates({ background }).catch((err: unknown) => {
        log('[AutoUpdater] Check failed:', err);
      });
    };

    autoUpdater.on('checking-for-update', () => {
      if (
        shouldPreserveReadyOnChecking({
          pendingDownloadVersion,
          currentVersion: getCurrentVersion(),
        })
      ) {
        return;
      }
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

    autoUpdater.on('update-not-available', (info) => {
      if (
        shouldPreserveReadyOnNotAvailable({
          pendingDownloadVersion,
          currentVersion: getCurrentVersion(),
          feedVersion: info?.version,
        })
      ) {
        restoreReadyStatus();
        return;
      }
      pendingDownloadVersion = null;
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
      pendingDownloadVersion = info.version;
      setStatus({
        status: 'ready',
        version: info.version,
        percent: 100,
        message: undefined,
      });
      log('[AutoUpdater] Update downloaded:', info.version);
      scheduleRecheckForNewerRelease(runCheck, log);
    });

    autoUpdater.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log('[AutoUpdater] Error:', message);
      if (
        shouldPreserveReadyOnError({
          pendingDownloadVersion,
          currentVersion: getCurrentVersion(),
        })
      ) {
        restoreReadyStatus();
        return;
      }
    });

    const scheduleNextCheck = (delayMs: number) => {
      if (checkTimer) clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        runCheck(Boolean(pendingDownloadVersion));
        // Steady hourly cadence after the staggered first recurring check.
        scheduleNextCheck(UPDATE_CHECK_INTERVAL_MS);
      }, delayMs);
    };

    // Check immediately on startup (e.g. after restart-to-upgrade) so a newer
    // feed release is detected without waiting for the staggered poll.
    runCheck();

    // Stagger recurring checks so installs don't poll the feed in lockstep.
    scheduleNextCheck(nextUpdateCheckDelayMs());
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
    clearTimeout(checkTimer);
    checkTimer = null;
  }
  if (readyRecheckTimer) {
    clearTimeout(readyRecheckTimer);
    readyRecheckTimer = null;
  }
}
