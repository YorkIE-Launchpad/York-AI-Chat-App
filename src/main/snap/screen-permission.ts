/**
 * Screen Recording permission flow for Screen Snap (macOS).
 * macOS only applies a new Screen Recording grant after the app relaunches,
 * so once access is granted we restart GrowthOS automatically.
 */
import { app, desktopCapturer, dialog, shell, systemPreferences } from 'electron';
import { log, logWarn } from '../utils/logger';

export const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
/** Passed to the relaunched process so it can confirm Screen Snap is ready. */
export const SCREEN_PERMISSION_RELAUNCH_FLAG = '--screen-snap-permission-granted';
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export interface ScreenPermissionDeps {
  getStatus?: () => string;
  /** Registers the app in the Screen Recording list and shows the native prompt the first time. */
  requestNative?: () => Promise<void>;
  /** Resolves true when the user chooses to continue. */
  confirm?: () => Promise<boolean>;
  openSettings?: () => Promise<void>;
  relaunch?: () => void;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  now?: () => number;
}

const defaultRequestNative = async (): Promise<void> => {
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch (error) {
    logWarn('[ScreenSnap] desktopCapturer permission request failed', error);
  }
};

const defaultConfirm = async (): Promise<boolean> => {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Allow Screen Recording',
    message: 'York GrowthOS needs Screen Recording permission for Screen Snap.',
    detail:
      'Turn on York GrowthOS in System Settings > Privacy & Security > Screen Recording. ' +
      'GrowthOS will restart automatically as soon as access is granted.',
    buttons: ['Allow Access…', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
};

const defaultRelaunch = (): void => {
  const args = process.argv.slice(1).filter((arg) => arg !== SCREEN_PERMISSION_RELAUNCH_FLAG);
  app.relaunch({ args: [...args, SCREEN_PERMISSION_RELAUNCH_FLAG] });
  app.exit(0);
};

export class ScreenRecordingPermission {
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private readonly deps: Required<ScreenPermissionDeps>;

  constructor(deps: ScreenPermissionDeps = {}) {
    this.deps = {
      getStatus: deps.getStatus ?? (() => systemPreferences.getMediaAccessStatus('screen')),
      requestNative: deps.requestNative ?? defaultRequestNative,
      confirm: deps.confirm ?? defaultConfirm,
      openSettings: deps.openSettings ?? (() => shell.openExternal(SCREEN_RECORDING_SETTINGS_URL)),
      relaunch: deps.relaunch ?? defaultRelaunch,
      setInterval: deps.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
      clearInterval: deps.clearInterval ?? ((handle) => clearInterval(handle)),
      now: deps.now ?? (() => Date.now()),
    };
  }

  isGranted(): boolean {
    return this.deps.getStatus() === 'granted';
  }

  get isWaiting(): boolean {
    return this.pollHandle !== null;
  }

  /**
   * Returns true when capture can proceed. Otherwise asks for permission,
   * opens System Settings, and relaunches the app once access is granted.
   */
  async ensure(): Promise<boolean> {
    if (this.isGranted()) return true;

    if (this.isWaiting) {
      await this.deps.openSettings();
      return false;
    }

    if (!(await this.deps.confirm())) return false;

    await this.deps.requestNative();
    if (this.isGranted()) return true;

    await this.deps.openSettings();
    this.waitForGrant();
    return false;
  }

  dispose(): void {
    if (this.pollHandle) {
      this.deps.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private waitForGrant(): void {
    if (this.pollHandle) return;
    const deadline = this.deps.now() + POLL_TIMEOUT_MS;
    this.pollHandle = this.deps.setInterval(() => {
      if (this.isGranted()) {
        this.dispose();
        log('[ScreenSnap] Screen Recording granted; relaunching');
        this.deps.relaunch();
        return;
      }
      if (this.deps.now() > deadline) {
        this.dispose();
      }
    }, POLL_INTERVAL_MS);
  }
}
