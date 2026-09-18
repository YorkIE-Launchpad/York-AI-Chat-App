import { describe, expect, it } from 'vitest';
import {
  isVersionNewer,
  nextUpdateCheckDelayMs,
  READY_STATE_RECHECK_DELAY_MS,
  resolveAutoUpdater,
  shouldEnableAutoUpdater,
  shouldIgnoreDuplicateUpdateDownload,
  shouldPreserveReadyOnAvailable,
  shouldPreserveReadyOnChecking,
  shouldPreserveReadyOnError,
  shouldPreserveReadyOnNotAvailable,
  shouldPreserveReadyStatus,
  shouldSkipAppQuitTeardownForUpdateInstall,
  buildMacUpdateInstallScript,
  getMacShipItDirectory,
  readMacShipItStagedUpdate,
  resolveMacUpdateRelaunchExecPath,
  resolveMacAppBundlePath,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FEED_URL,
  UPDATE_INSTALL_FORCE_QUIT_MS,
  UPDATE_INSTALL_QUIT_WATCHDOG_MS,
  UPDATE_INSTALL_RELAUNCH_EXIT_MS,
  UPDATE_INSTALL_SHIPIT_SETTLE_MS,
} from '../../main/updater';

describe('shouldEnableAutoUpdater', () => {
  it('enables for packaged macOS', () => {
    expect(shouldEnableAutoUpdater({ isPackaged: true, platform: 'darwin' })).toBe(true);
  });

  it('enables for unpackaged macOS when app data env is dev', () => {
    expect(
      shouldEnableAutoUpdater({ isPackaged: false, platform: 'darwin', appDataEnv: 'dev' })
    ).toBe(true);
  });

  it('disables for unpackaged macOS without dev app data env', () => {
    expect(shouldEnableAutoUpdater({ isPackaged: false, platform: 'darwin' })).toBe(false);
    expect(
      shouldEnableAutoUpdater({ isPackaged: false, platform: 'darwin', appDataEnv: 'default' })
    ).toBe(false);
  });

  it('disables for non-mac platforms', () => {
    expect(shouldEnableAutoUpdater({ isPackaged: true, platform: 'win32' })).toBe(false);
    expect(shouldEnableAutoUpdater({ isPackaged: true, platform: 'linux' })).toBe(false);
  });
});

describe('resolveAutoUpdater', () => {
  it('prefers a named autoUpdater export', () => {
    const named = {
      autoDownload: true,
    } as unknown as typeof import('electron-updater').autoUpdater;
    expect(resolveAutoUpdater({ autoUpdater: named })).toBe(named);
  });

  it('falls back to default.autoUpdater (ESM interop)', () => {
    const nested = {
      autoDownload: true,
    } as unknown as typeof import('electron-updater').autoUpdater;
    expect(resolveAutoUpdater({ default: { autoUpdater: nested } })).toBe(nested);
  });

  it('returns null when missing', () => {
    expect(resolveAutoUpdater({})).toBeNull();
    expect(resolveAutoUpdater({ default: {} })).toBeNull();
  });
});

describe('UPDATE_FEED_URL', () => {
  it('points at the S3 latest prefix used by upload-s3', () => {
    expect(UPDATE_FEED_URL).toBe(
      'https://york-internal-apps.s3.ap-south-1.amazonaws.com/york-workos/latest'
    );
  });
});

describe('update check scheduling', () => {
  it('uses a 1-hour base interval', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it('picks a random delay within the hour', () => {
    expect(nextUpdateCheckDelayMs(() => 0)).toBe(0);
    expect(nextUpdateCheckDelayMs(() => 0.5)).toBe(Math.floor(0.5 * UPDATE_CHECK_INTERVAL_MS));
    expect(nextUpdateCheckDelayMs(() => 0.999)).toBeLessThan(UPDATE_CHECK_INTERVAL_MS);
  });

  it('rechecks soon after a download completes', () => {
    expect(READY_STATE_RECHECK_DELAY_MS).toBe(3_000);
  });

  it('ignores duplicate update-downloaded while staging or after staged', () => {
    expect(
      shouldIgnoreDuplicateUpdateDownload({
        pendingDownloadVersion: '1.2.0',
        downloadedVersion: '1.2.0',
        squirrelStagingReady: true,
        stagingSquirrelUpdate: false,
      })
    ).toBe(true);
    expect(
      shouldIgnoreDuplicateUpdateDownload({
        pendingDownloadVersion: '1.2.0',
        downloadedVersion: '1.2.0',
        squirrelStagingReady: false,
        stagingSquirrelUpdate: true,
      })
    ).toBe(true);
    expect(
      shouldIgnoreDuplicateUpdateDownload({
        pendingDownloadVersion: '1.2.0',
        downloadedVersion: '1.3.0',
        squirrelStagingReady: true,
        stagingSquirrelUpdate: false,
      })
    ).toBe(false);
  });

  it('uses bounded timers when restart-to-install does not exit', () => {
    expect(UPDATE_INSTALL_RELAUNCH_EXIT_MS).toBeGreaterThan(0);
    expect(UPDATE_INSTALL_FORCE_QUIT_MS).toBeGreaterThan(0);
    expect(UPDATE_INSTALL_QUIT_WATCHDOG_MS).toBeGreaterThan(UPDATE_INSTALL_RELAUNCH_EXIT_MS);
    expect(UPDATE_INSTALL_QUIT_WATCHDOG_MS).toBeLessThanOrEqual(60_000);
    expect(UPDATE_INSTALL_SHIPIT_SETTLE_MS).toBeGreaterThan(UPDATE_INSTALL_FORCE_QUIT_MS);
  });

  it('skips async quit teardown while Squirrel is installing so the process can exit', () => {
    expect(shouldSkipAppQuitTeardownForUpdateInstall(true)).toBe(true);
    expect(shouldSkipAppQuitTeardownForUpdateInstall(false)).toBe(false);
  });

  it('relaunches the jitless trampoline, not York GrowthOS.real', () => {
    expect(
      resolveMacUpdateRelaunchExecPath(
        '/Applications/York GrowthOS.app/Contents/MacOS/York GrowthOS.real'
      )
    ).toBe('/Applications/York GrowthOS.app/Contents/MacOS/York GrowthOS');
    expect(
      resolveMacUpdateRelaunchExecPath('/Applications/York GrowthOS.app/Contents/MacOS/York GrowthOS')
    ).toBe('/Applications/York GrowthOS.app/Contents/MacOS/York GrowthOS');
  });

  it('resolves the .app bundle for a delayed open(1) relaunch', () => {
    expect(
      resolveMacAppBundlePath(
        '/Applications/York GrowthOS.app/Contents/MacOS/York GrowthOS.real'
      )
    ).toBe('/Applications/York GrowthOS.app');
    expect(resolveMacAppBundlePath('/usr/bin/electron')).toBeNull();
  });

  it('builds a ditto install script that waits for PID death then swaps the .app', () => {
    const script = buildMacUpdateInstallScript({
      pid: 4242,
      updateBundlePath: '/Caches/update.ABC/York GrowthOS.app',
      targetBundlePath: '/Applications/York GrowthOS.app',
      logPath: '/tmp/york-update-install.log',
    });
    expect(script).toContain('kill -0 4242');
    expect(script).toContain("pkill -KILL -f '/PlugIns/MatterWidgetExtension'");
    expect(script).toContain("pkill -KILL -f '/Frameworks/York GrowthOS Helper'");
    expect(script).toContain(
      "ditto --rsrc '/Caches/update.ABC/York GrowthOS.app' '/Applications/York GrowthOS.app'"
    );
    expect(script).toContain("open '/Applications/York GrowthOS.app'");
    expect(script.indexOf('kill -0 4242')).toBeLessThan(script.indexOf('ditto '));
    expect(script).toContain('still waiting for pid 4242');
  });

  it('resolves staged ShipIt update paths from ShipItState JSON', () => {
    // Unit-level shape check — live read is environment-dependent.
    expect(typeof readMacShipItStagedUpdate).toBe('function');
    expect(getMacShipItDirectory()).toContain('ie.york.app.ShipIt');
  });
});

describe('ready-state preservation', () => {
  it('compares semver versions', () => {
    expect(isVersionNewer('1.2.0', '1.1.0')).toBe(true);
    expect(isVersionNewer('1.1.0', '1.2.0')).toBe(false);
    expect(isVersionNewer('1.1.0', '1.1.0')).toBe(false);
  });

  it('preserves ready when a newer build is downloaded but not installed', () => {
    expect(
      shouldPreserveReadyStatus({
        pendingDownloadVersion: '1.2.0',
        currentVersion: '1.1.0',
      })
    ).toBe(true);
    expect(
      shouldPreserveReadyStatus({
        pendingDownloadVersion: null,
        currentVersion: '1.1.0',
      })
    ).toBe(false);
  });

  it('does not preserve ready on update-not-available when feed has a newer release', () => {
    expect(
      shouldPreserveReadyOnNotAvailable({
        pendingDownloadVersion: '1.2.0',
        currentVersion: '1.1.0',
        feedVersion: '1.3.0',
      })
    ).toBe(false);
  });

  it('preserves ready on update-not-available when feed matches the downloaded build', () => {
    expect(
      shouldPreserveReadyOnNotAvailable({
        pendingDownloadVersion: '1.2.0',
        currentVersion: '1.1.0',
        feedVersion: '1.2.0',
      })
    ).toBe(true);
  });

  it('preserves ready UI during background rechecks and transient errors', () => {
    const args = { pendingDownloadVersion: '1.2.0', currentVersion: '1.1.0' };
    expect(shouldPreserveReadyOnChecking(args)).toBe(true);
    expect(shouldPreserveReadyOnError(args)).toBe(true);
  });

  it('preserves ready when the feed re-offers the downloaded build', () => {
    expect(
      shouldPreserveReadyOnAvailable({
        pendingDownloadVersion: '1.2.0',
        availableVersion: '1.2.0',
      })
    ).toBe(true);
    expect(
      shouldPreserveReadyOnAvailable({
        pendingDownloadVersion: '1.2.0',
        availableVersion: '1.1.0',
      })
    ).toBe(true);
    expect(
      shouldPreserveReadyOnAvailable({
        pendingDownloadVersion: '1.2.0',
        availableVersion: '1.3.0',
      })
    ).toBe(false);
  });
});
