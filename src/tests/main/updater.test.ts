import { describe, expect, it } from 'vitest';
import { resolveAutoUpdater, shouldEnableAutoUpdater, UPDATE_FEED_URL } from '../../main/updater';

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
