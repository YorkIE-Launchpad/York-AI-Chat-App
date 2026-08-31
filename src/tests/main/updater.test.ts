import { describe, expect, it } from 'vitest';
import {
  isVersionNewer,
  nextUpdateCheckDelayMs,
  READY_STATE_RECHECK_DELAY_MS,
  resolveAutoUpdater,
  shouldEnableAutoUpdater,
  shouldPreserveReadyOnChecking,
  shouldPreserveReadyOnError,
  shouldPreserveReadyOnNotAvailable,
  shouldPreserveReadyStatus,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FEED_URL,
} from '../../main/updater';

describe('shouldEnableAutoUpdater', () => {
  it('enables only for packaged macOS', () => {
    expect(shouldEnableAutoUpdater({ isPackaged: true, platform: 'darwin' })).toBe(true);
  });

  it('disables for unpackaged / non-mac platforms', () => {
    expect(shouldEnableAutoUpdater({ isPackaged: false, platform: 'darwin' })).toBe(false);
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
});
