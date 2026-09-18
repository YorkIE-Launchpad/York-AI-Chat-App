/**
 * macOS auto-update via electron-updater + S3 generic feed.
 * Downloads in the background; install is user-triggered via quitAndInstall.
 */
import { app, BrowserWindow, autoUpdater as squirrelAutoUpdater } from 'electron';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { UpdaterStatus, UpdaterStatusKind } from '../shared/updater-types';
import { resolveAppDataEnv } from '../shared/app-data-env';
import { logWarn } from './utils/logger';
import { notifyUpdateInstallAborted, notifyUpdateInstallWillQuit } from './update-quit-coordination';

function persistUpdaterLog(message: string, detail?: unknown): void {
  if (detail === undefined) {
    logWarn('[AutoUpdater]', message);
    return;
  }
  logWarn('[AutoUpdater]', message, detail);
}

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

/** Ignore electron-updater re-emitting update-downloaded for an already-staged build. */
export function shouldIgnoreDuplicateUpdateDownload(opts: {
  pendingDownloadVersion: string | null;
  downloadedVersion: string;
  squirrelStagingReady: boolean;
  stagingSquirrelUpdate: boolean;
}): boolean {
  if (opts.pendingDownloadVersion !== opts.downloadedVersion) return false;
  return opts.squirrelStagingReady || opts.stagingSquirrelUpdate;
}

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

/** Avoid regressing "restart to update" when the feed re-offers an already-downloaded build. */
export function shouldPreserveReadyOnAvailable(opts: {
  pendingDownloadVersion: string | null;
  availableVersion: string;
}): boolean {
  if (!opts.pendingDownloadVersion) return false;
  return !isVersionNewer(opts.availableVersion, opts.pendingDownloadVersion);
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
  /** When `dev`, enables updater in unpackaged `npm run dev` on macOS for testing. */
  appDataEnv?: string;
}): boolean {
  if (opts.platform !== 'darwin') return false;
  if (opts.isPackaged) return true;
  const env = opts.appDataEnv ?? resolveAppDataEnv();
  return env === 'dev';
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
let installQuitWatchdog: ReturnType<typeof setTimeout> | null = null;
let installForceQuitTimer: ReturnType<typeof setTimeout> | null = null;
let stagingSquirrelUpdate = false;
/** Squirrel accepted the downloaded build (signature OK) and staged it for quitAndInstall. */
let squirrelStagingReady = false;
let lastStagingError: string | null = null;

export function formatUpdateStagingErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('code signature') || lower.includes('code requirement')) {
    return (
      'The downloaded update failed Apple code signature checks, so it cannot be installed automatically. ' +
      'Squirrel.Mac requires the update .app to satisfy the running Electron binary’s designated requirement. ' +
      'A bash jitless wrapper signs the .app as ie.york.app but the running *.real process as "York GrowthOS", which fails that check even when `codesign --verify --deep --strict` passes. ' +
      'Install the latest signed DMG from your release channel, or rebuild with the Mach-O trampoline + matching codesign identifier, then re-upload. ' +
      `Detail: ${raw}`
    );
  }
  return raw;
}

function applyStagingFailure(raw: string): void {
  stagingSquirrelUpdate = false;
  squirrelStagingReady = false;
  lastStagingError = raw;
  const message = formatUpdateStagingErrorMessage(raw);
  persistUpdaterLog('Update staging failed:', raw);
  if (installingUpdate) {
    notifyUpdateInstallAborted();
  }
  setStatus({
    status: 'error',
    version: pendingDownloadVersion ?? currentStatus.version,
    message,
  });
}
/**
 * Last-resort delay before force-exit if Squirrel never emits before-quit-for-update.
 * Must stay short: a frozen Electron quit loop will not run long timers.
 */
export const UPDATE_INSTALL_FORCE_QUIT_MS = 250;
/** @deprecated Prefer UPDATE_INSTALL_FORCE_QUIT_MS; kept for existing tests. */
export const UPDATE_INSTALL_RELAUNCH_EXIT_MS = UPDATE_INSTALL_FORCE_QUIT_MS;
/** Surface an error in UI if the app is still running (user can retry or Cmd+Q). */
export const UPDATE_INSTALL_QUIT_WATCHDOG_MS = 8_000;
/**
 * Max time the detached installer waits after PID death before giving up on the swap.
 * (Legacy name kept for tests — no longer a ShipIt poll window.)
 */
export const UPDATE_INSTALL_SHIPIT_SETTLE_MS = 15_000;

/** electron-builder appId — Squirrel.Mac cache folder under ~/Library/Caches. */
export const MACOS_UPDATE_APP_ID = 'ie.york.app';

/**
 * Squirrel.Mac / ShipIt can only replace the .app after this process actually exits.
 * Async quit teardown (MCP, Lima, sandbox) and ref'd timers keep the event loop
 * alive with no windows — the Dock shows "running in background", ShipIt aborts
 * with "App Still Running", and there is no automatic relaunch.
 */
export function shouldSkipAppQuitTeardownForUpdateInstall(installing: boolean): boolean {
  return installing;
}

/**
 * The jitless trampoline execv's `*.real`. Dock/CLI launch must use the trampoline
 * so --jitless is applied; process.execPath after exec is the .real binary.
 */
export function resolveMacUpdateRelaunchExecPath(execPath: string): string {
  return execPath.endsWith('.real') ? execPath.slice(0, -'.real'.length) : execPath;
}

/** `/Applications/York GrowthOS.app` from a MacOS executable path. */
export function resolveMacAppBundlePath(execPath: string): string | null {
  const marker = '.app/Contents/MacOS/';
  const idx = execPath.lastIndexOf(marker);
  if (idx === -1) return null;
  return execPath.slice(0, idx + '.app'.length);
}

export function getMacShipItDirectory(appId: string = MACOS_UPDATE_APP_ID): string {
  return path.join(os.homedir(), 'Library', 'Caches', `${appId}.ShipIt`);
}

/**
 * Read the staged update bundle Squirrel already signature-checked.
 * ShipItState.plist is JSON on modern Electron (not XML).
 */
export function readMacShipItStagedUpdate(appId: string = MACOS_UPDATE_APP_ID): {
  updateBundlePath: string;
  targetBundlePath: string;
} | null {
  try {
    const statePath = path.join(getMacShipItDirectory(appId), 'ShipItState.plist');
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw) as {
      updateBundleURL?: string;
      targetBundleURL?: string;
    };
    if (!state.updateBundleURL || !state.targetBundleURL) return null;
    const updateBundlePath = fileURLToPath(state.updateBundleURL);
    const targetBundlePath = fileURLToPath(state.targetBundleURL);
    if (!fs.existsSync(path.join(updateBundlePath, 'Contents', 'Info.plist'))) {
      return null;
    }
    return { updateBundlePath, targetBundlePath };
  } catch {
    return null;
  }
}

/**
 * Detached installer: wait for our PID to die, kill stragglers (Helpers, widget
 * appex, MCP node), `ditto` the staged update over the live .app, then `open`.
 *
 * We intentionally do **not** call Squirrel `quitAndInstall` / ShipIt for the swap.
 * ShipIt starts while Electron is still alive and aborts with "App Still Running"
 * on Tahoe; relaunch then never happens (`launchAfterInstallation: false`).
 */
export function buildMacUpdateInstallScript(opts: {
  pid: number;
  updateBundlePath: string;
  targetBundlePath: string;
  logPath?: string;
}): string {
  const logPath =
    opts.logPath ?? path.join(getMacShipItDirectory(), 'york-update-install.log');
  const update = opts.updateBundlePath.replace(/\/$/, '');
  const target = opts.targetBundlePath.replace(/\/$/, '');
  // Quote for zsh single-quoted strings (paths may contain spaces).
  const q = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;
  return [
    `LOG=${q(logPath)}`,
    `exec >>"$LOG" 2>&1`,
    `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) york-update-install start pid=${opts.pid} installer=$$"`,
    `echo "update=${update}"`,
    `echo "target=${target}"`,
    // Heartbeat so we can see if Electron reaped us during the wait.
    `i=0`,
    `while kill -0 ${opts.pid} 2>/dev/null; do`,
    `  i=$((i+1))`,
    `  if [ $((i % 20)) -eq 0 ]; then echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) still waiting for pid ${opts.pid} ($i)"; fi`,
    `  sleep 0.05`,
    `  if [ "$i" -gt 6000 ]; then echo "timeout waiting for pid ${opts.pid}"; exit 1; fi`,
    `done`,
    `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pid ${opts.pid} exited"`,
    // Stragglers that keep Launch Services thinking the app is running.
    // Avoid matching this installer (nohup/zsh script under ShipIt cache).
    `pkill -KILL -f '/Frameworks/York GrowthOS Helper' 2>/dev/null || true`,
    `pkill -KILL -f '/PlugIns/MatterWidgetExtension' 2>/dev/null || true`,
    `pkill -KILL -f '/Contents/MacOS/York GrowthOS' 2>/dev/null || true`,
    `pkill -KILL -f '/Contents/Resources/node/' 2>/dev/null || true`,
    `pkill -KILL -f '/Contents/Resources/mcp/' 2>/dev/null || true`,
    `pkill -KILL -f 'mcp-remote https://pulse.yorkdevs.link' 2>/dev/null || true`,
    `pkill -KILL -f 'mcp-remote https://launchpad.yorkdevs.link' 2>/dev/null || true`,
    `sleep 0.5`,
    `if [ ! -d ${q(update + '/Contents')} ]; then echo "missing update bundle: ${update}"; exit 1; fi`,
    `if [ ! -d ${q(target)} ]; then echo "missing target app: ${target}"; exit 1; fi`,
    // Replace in place with ditto (no mv of /Applications — fewer permission failures).
    `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ditto start"`,
    `ditto --rsrc ${q(update)} ${q(target)}`,
    `DITTO_EC=$?`,
    `if [ "$DITTO_EC" -ne 0 ]; then echo "ditto failed ec=$DITTO_EC"; exit "$DITTO_EC"; fi`,
    `xattr -cr ${q(target)} 2>/dev/null || true`,
    `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ditto complete; launching"`,
    `open ${q(target)}`,
    `OPEN_EC=$?`,
    `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) open issued ec=$OPEN_EC; done"`,
    `exit 0`,
  ].join('\n');
}

/** @deprecated Use buildMacUpdateInstallScript — kept for older tests / call sites. */
export function buildMacUpdateRelaunchScript(opts: {
  pid: number;
  bundlePath: string;
  shipItSettleMs?: number;
}): string {
  const staged = readMacShipItStagedUpdate();
  return buildMacUpdateInstallScript({
    pid: opts.pid,
    updateBundlePath: staged?.updateBundlePath ?? `${opts.bundlePath}.missing-update`,
    targetBundlePath: staged?.targetBundlePath ?? opts.bundlePath,
  });
}

function clearInstallQuitTimers(): void {
  if (installQuitWatchdog) {
    clearTimeout(installQuitWatchdog);
    installQuitWatchdog = null;
  }
  if (installForceQuitTimer) {
    clearTimeout(installForceQuitTimer);
    installForceQuitTimer = null;
  }
}

/**
 * Spawn the post-exit ditto installer so it survives Electron SIGKILL.
 * Plain `spawn({detached:true})` is still reaped when the Electron app exits on macOS;
 * `nohup … &` from a short sync shell actually orphans the installer.
 */
function spawnDetachedMacUpdateInstaller(staged: {
  updateBundlePath: string;
  targetBundlePath: string;
}): boolean {
  if (process.platform !== 'darwin') return false;
  const pid = process.pid;
  const shipItDir = getMacShipItDirectory();
  try {
    fs.mkdirSync(shipItDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const logPath = path.join(shipItDir, 'york-update-install.log');
  const scriptPath = path.join(shipItDir, `york-update-install-${pid}.sh`);
  const scriptBody = buildMacUpdateInstallScript({
    pid,
    updateBundlePath: staged.updateBundlePath,
    targetBundlePath: staged.targetBundlePath,
    logPath,
  });
  try {
    fs.writeFileSync(scriptPath, `#!/bin/zsh\n${scriptBody}\n`, { mode: 0o755 });
    // Sync launch: outer shell starts nohup child, prints its pid, exits.
    // The nohup child is not Electron's child and survives app.exit / SIGKILL.
    const installerPid = execFileSync(
      '/bin/zsh',
      [
        '-c',
        `nohup /bin/zsh ${JSON.stringify(scriptPath)} </dev/null >/dev/null 2>&1 & echo $!`,
      ],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    persistUpdaterLog('Detached mac update installer started', {
      pid,
      installerPid,
      scriptPath,
      updateBundlePath: staged.updateBundlePath,
      targetBundlePath: staged.targetBundlePath,
    });
    return Boolean(installerPid);
  } catch (error) {
    persistUpdaterLog('Failed to spawn detached mac update installer', error);
    return false;
  }
}

/** Best-effort kill of helpers / widget / orphans before we SIGKILL ourselves. */
export function killMacUpdateStragglerProcesses(): void {
  if (process.platform !== 'darwin') return;
  // Do NOT pkill Contents/MacOS here — that races our own exit and can confuse
  // diagnostics. SIGKILL on process.pid is enough for the main binary.
  const patterns = [
    '/Frameworks/York GrowthOS Helper',
    '/PlugIns/MatterWidgetExtension',
    '/Resources/tools/York GrowthOS.app',
    '/meeting-speech-transcriber',
    '/Contents/Resources/node/',
    '/Contents/Resources/mcp/',
  ];
  for (const pattern of patterns) {
    try {
      execFileSync('pkill', ['-KILL', '-f', pattern], { stdio: 'ignore', timeout: 2000 });
    } catch {
      /* no matches or pkill unavailable */
    }
  }
}

/**
 * Force-exit for update install. Prefer SIGKILL — app.exit often leaves Helpers
 * alive long enough for ShipIt to abort with App Still Running.
 */
function forceExitForUpdateInstall(): void {
  persistUpdaterLog('Forcing process exit for update install');
  try {
    app.dock?.hide();
  } catch {
    /* ignore */
  }
  try {
    app.releaseSingleInstanceLock();
  } catch {
    /* ignore */
  }
  try {
    killMacUpdateStragglerProcesses();
  } catch {
    /* ignore */
  }
  try {
    app.exit(0);
  } catch {
    /* ignore */
  }
  try {
    process.exit(0);
  } catch {
    /* ignore */
  }
  try {
    process.kill(process.pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
}

function failInstallQuit(message: string): void {
  persistUpdaterLog('Install quit failed:', message);
  clearInstallQuitTimers();
  installingUpdate = false;
  notifyUpdateInstallAborted();
  setStatus({ status: 'error', message });
}

/**
 * With autoInstallOnAppQuit=false, Squirrel only pulls the staged zip when checkForUpdates
 * runs against electron-updater's local proxy. Pre-stage after download so "Restart to update"
 * can call native quitAndInstall immediately instead of hanging on checkForUpdates.
 */
function stageSquirrelUpdateForInstall(): void {
  if (stagingSquirrelUpdate) return;
  stagingSquirrelUpdate = true;
  squirrelStagingReady = false;
  persistUpdaterLog('Staging downloaded update in Squirrel…');

  const onStaged = (): void => {
    stagingSquirrelUpdate = false;
    squirrelStagingReady = true;
    lastStagingError = null;
    persistUpdaterLog('Squirrel staging complete (ready for quitAndInstall)');
    if (pendingDownloadVersion) {
      setStatus({
        status: 'ready',
        version: pendingDownloadVersion,
        percent: 100,
        message: undefined,
      });
    }
  };
  const onStageError = (err: Error): void => {
    applyStagingFailure(err?.message ?? String(err));
  };

  squirrelAutoUpdater.once('update-downloaded', onStaged);
  squirrelAutoUpdater.once('error', onStageError);

  try {
    squirrelAutoUpdater.checkForUpdates();
  } catch (err) {
    stagingSquirrelUpdate = false;
    squirrelAutoUpdater.removeListener('update-downloaded', onStaged);
    squirrelAutoUpdater.removeListener('error', onStageError);
    persistUpdaterLog('Squirrel checkForUpdates failed:', err);
  }
}
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let readyRecheckTimer: ReturnType<typeof setTimeout> | null = null;
/** At most one post-download feed recheck per pending version (avoids staging / UI flicker loops). */
let readyRecheckScheduledForVersion: string | null = null;
let started = false;
let autoUpdaterInstance: typeof import('electron-updater').autoUpdater | null = null;
/** Version downloaded to disk and awaiting user-triggered install. */
let pendingDownloadVersion: string | null = null;

const listeners = new Set<StatusListener>();

function isDevUpdaterContext(): boolean {
  return !app.isPackaged && resolveAppDataEnv() === 'dev';
}

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
      listener(getUpdaterStatus());
    } catch {
      /* ignore listener errors */
    }
  }
  broadcastToWindows(currentStatus);
}

function broadcastToWindows(status: UpdaterStatus): void {
  const payload: UpdaterStatus = {
    ...status,
    installPrepared: squirrelStagingReady,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('updater:status', payload);
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

function scheduleRecheckForNewerRelease(runCheck: (background: boolean) => void): void {
  if (!pendingDownloadVersion) return;
  if (readyRecheckScheduledForVersion === pendingDownloadVersion) return;
  readyRecheckScheduledForVersion = pendingDownloadVersion;
  if (readyRecheckTimer) clearTimeout(readyRecheckTimer);
  readyRecheckTimer = setTimeout(() => {
    readyRecheckTimer = null;
    persistUpdaterLog('Re-checking feed for newer release (pending)', pendingDownloadVersion);
    runCheck(true);
  }, READY_STATE_RECHECK_DELAY_MS);
}

function handleUpdateDownloaded(
  info: { version: string },
  runCheck: (background: boolean) => void
): void {
  const version = info.version;
  if (
    shouldIgnoreDuplicateUpdateDownload({
      pendingDownloadVersion,
      downloadedVersion: version,
      squirrelStagingReady,
      stagingSquirrelUpdate,
    })
  ) {
    if (squirrelStagingReady) {
      restoreReadyStatus();
    }
    return;
  }

  pendingDownloadVersion = version;
  squirrelStagingReady = false;
  lastStagingError = null;
  setStatus({
    status: 'ready',
    version,
    percent: 100,
    message: 'Preparing update for install…',
  });
  persistUpdaterLog('Update downloaded (awaiting Squirrel staging):', version);
  stageSquirrelUpdateForInstall();
  scheduleRecheckForNewerRelease(runCheck);
}

export function getUpdaterStatus(): UpdaterStatus {
  return {
    ...currentStatus,
    installPrepared: squirrelStagingReady,
  };
}

export function getUpdaterInternalDiagnostics(): Record<string, unknown> {
  return {
    started,
    hasAutoUpdaterInstance: Boolean(autoUpdaterInstance),
    pendingDownloadVersion,
    installingUpdate,
    stagingSquirrelUpdate,
    squirrelStagingReady,
    lastStagingError,
    hasInstallQuitWatchdog: Boolean(installQuitWatchdog),
    hasInstallForceQuitTimer: Boolean(installForceQuitTimer),
    appDataEnv: resolveAppDataEnv(),
    isDevUpdaterContext: isDevUpdaterContext(),
  };
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

export async function quitAndInstallUpdate(): Promise<{ success: boolean; error?: string }> {
  persistUpdaterLog('quitAndInstallUpdate invoked', {
    status: currentStatus,
    internal: getUpdaterInternalDiagnostics(),
  });

  if (!autoUpdaterInstance) {
    const error = 'Updater is not available';
    persistUpdaterLog('quitAndInstall rejected:', error);
    return { success: false, error };
  }

  if (currentStatus.status === 'available' && isDevUpdaterContext()) {
    persistUpdaterLog('Dev: downloading update before install');
    try {
      setStatus({
        status: 'downloading',
        version: currentStatus.version,
        percent: currentStatus.percent ?? 0,
        message: undefined,
      });
      await autoUpdaterInstance.downloadUpdate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      persistUpdaterLog('Dev downloadUpdate failed:', message);
      setStatus({ status: 'error', message });
      return { success: false, error: message };
    }
  }

  if (currentStatus.status !== 'ready') {
    const error = `No update is ready to install (status=${currentStatus.status})`;
    persistUpdaterLog('quitAndInstall rejected:', error);
    return { success: false, error };
  }

  if (!squirrelStagingReady) {
    const error =
      lastStagingError != null
        ? formatUpdateStagingErrorMessage(lastStagingError)
        : stagingSquirrelUpdate
          ? 'Update is still preparing. Wait a few seconds and try again.'
          : 'Update is not staged for install yet. Try Check for updates again.';
    persistUpdaterLog('quitAndInstall rejected (Squirrel not staged):', error);
    return { success: false, error };
  }

  installingUpdate = true;
  stopAutoUpdaterChecks();
  clearInstallQuitTimers();
  setStatus({
    status: 'ready',
    version: currentStatus.version,
    percent: 100,
    message: 'Restarting to install update…',
  });

  // macOS: swap the already-staged Squirrel bundle ourselves after exit.
  // Native quitAndInstall launches ShipIt while we are still alive → App Still Running.
  const staged = process.platform === 'darwin' ? readMacShipItStagedUpdate() : null;
  if (process.platform === 'darwin' && !staged) {
    const error =
      'Staged update bundle is missing. Try Check for updates again, then Restart to update.';
    persistUpdaterLog('quitAndInstall rejected (no ShipIt staged bundle):', error);
    installingUpdate = false;
    return { success: false, error };
  }

  persistUpdaterLog('Calling update install', {
    version: currentStatus.version,
    pendingDownloadVersion,
    stagingSquirrelUpdate,
    mode: staged ? 'detached-ditto' : 'electron-updater',
    staged,
  });

  const runQuitAndInstall = (): void => {
    notifyUpdateInstallWillQuit();
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.removeAllListeners('close');
          win.destroy();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }

    try {
      app.removeAllListeners('before-quit');
      app.removeAllListeners('window-all-closed');
    } catch {
      /* ignore */
    }

    if (staged) {
      // Installer already spawned synchronously below; just die hard.
      killMacUpdateStragglerProcesses();
      forceExitForUpdateInstall();
      return;
    }

    try {
      autoUpdaterInstance!.quitAndInstall();
      persistUpdaterLog('quitAndInstall() returned — forcing exit');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      persistUpdaterLog('quitAndInstall() threw:', message);
    }
    killMacUpdateStragglerProcesses();
    forceExitForUpdateInstall();
  };

  try {
    if (staged) {
      // Spawn BEFORE returning IPC — setImmediate was never firing on some quits.
      if (!spawnDetachedMacUpdateInstaller(staged)) {
        installingUpdate = false;
        return { success: false, error: 'Failed to start update installer' };
      }
    }

    // Brief delay so the renderer receives the IPC success before we tear down.
    setTimeout(runQuitAndInstall, 75);

    persistUpdaterLog('quitAndInstall scheduled', {
      forceQuitMs: UPDATE_INSTALL_FORCE_QUIT_MS,
      mode: staged ? 'detached-ditto' : 'electron-updater',
    });
    return { success: true };
  } catch (err) {
    failInstallQuit(err instanceof Error ? err.message : String(err));
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Start background update checks. No-op except on macOS (packaged, or dev with YORK_IE_APP_DATA_ENV=dev).
 */
export async function startAutoUpdater(): Promise<void> {
  if (started) return;
  started = true;

  const enabled = shouldEnableAutoUpdater({
    isPackaged: app.isPackaged,
    platform: process.platform,
    appDataEnv: resolveAppDataEnv(),
  });

  currentStatus = {
    status: enabled ? 'idle' : 'unsupported',
    currentVersion: getCurrentVersion(),
  };

  if (!enabled) {
    persistUpdaterLog('Skipped (requires macOS packaged app, or macOS dev with YORK_IE_APP_DATA_ENV=dev)');
    return;
  }

  if (!app.isPackaged) {
    persistUpdaterLog('Enabled in unpackaged dev (install/relaunch still needs Squirrel/.app)');
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
    autoUpdater.autoRunAppAfterInstall = true;

    squirrelAutoUpdater.on('before-quit-for-update', () => {
      installingUpdate = true;
      persistUpdaterLog('Squirrel before-quit-for-update — forcing exit');
      // ShipIt is already launched; Electron must die or install aborts with
      // "App Still Running" and Dock keeps a headless zombie.
      try {
        notifyUpdateInstallWillQuit();
      } catch {
        /* ignore */
      }
      forceExitForUpdateInstall();
    });
    squirrelAutoUpdater.on('error', (err) => {
      if (!installingUpdate && !stagingSquirrelUpdate) return;
      const message = err instanceof Error ? err.message : String(err);
      persistUpdaterLog('Squirrel autoUpdater error:', message);
      if (installingUpdate) {
        failInstallQuit(message);
      } else if (stagingSquirrelUpdate) {
        applyStagingFailure(message);
      }
    });

    autoUpdater.setFeedURL({
      provider: 'generic',
      url: UPDATE_FEED_URL,
    });

    const runCheck = (background = false) => {
      void checkForAppUpdates({ background }).catch((err: unknown) => {
        persistUpdaterLog('Check failed:', err);
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
      if (
        shouldPreserveReadyOnAvailable({
          pendingDownloadVersion,
          availableVersion: info.version,
        })
      ) {
        restoreReadyStatus();
        return;
      }
      setStatus({
        status: 'available',
        version: info.version,
        message: undefined,
        percent: 0,
      });
      persistUpdaterLog('Update available:', info.version);
      void autoUpdater.downloadUpdate().catch((err: unknown) => {
        persistUpdaterLog('downloadUpdate failed:', err);
      });
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
      readyRecheckScheduledForVersion = null;
      setStatus({
        status: 'idle',
        version: undefined,
        percent: undefined,
        message: undefined,
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      // Background re-download of an already-ready build can emit progress while UI
      // should stay on "restart to update".
      if (currentStatus.status === 'ready') {
        return;
      }
      setStatus({
        status: 'downloading',
        percent: Math.round(progress.percent),
        message: undefined,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      handleUpdateDownloaded(info, runCheck);
    });

    autoUpdater.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      persistUpdaterLog('electron-updater error:', message);
      if (stagingSquirrelUpdate || message.toLowerCase().includes('code signature')) {
        applyStagingFailure(message);
        return;
      }
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
    persistUpdaterLog('Started — feed:', UPDATE_FEED_URL);
  } catch (err) {
    persistUpdaterLog('Failed to load electron-updater:', err);
    setStatus({
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Stop background feed polling only (do not clear install quit watchdogs). */
export function stopAutoUpdaterChecks(): void {
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
  if (readyRecheckTimer) {
    clearTimeout(readyRecheckTimer);
    readyRecheckTimer = null;
  }
  readyRecheckScheduledForVersion = null;
}

export function stopAutoUpdater(): void {
  clearInstallQuitTimers();
  stopAutoUpdaterChecks();
}
