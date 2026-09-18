import { describe, expect, it } from 'vitest';
import {
  shouldShowRestartToUpdate,
  shouldShowUpdateReadyMessage,
  isUpdateStagingForInstall,
} from '../../shared/updater-types';

describe('shouldShowRestartToUpdate', () => {
  it('shows for ready in prod and dev', () => {
    expect(shouldShowRestartToUpdate('ready')).toBe(true);
    expect(shouldShowRestartToUpdate('ready', { installPrepared: true })).toBe(true);
  });

  it('hides restart when ready but Squirrel staging failed', () => {
    expect(shouldShowRestartToUpdate('ready', { installPrepared: false })).toBe(false);
  });

  it('shows for available only in Vite dev', () => {
    expect(shouldShowRestartToUpdate('available')).toBe(false);
    expect(shouldShowRestartToUpdate('available', { isViteDev: true })).toBe(true);
  });

  it('hides for other states', () => {
    expect(shouldShowRestartToUpdate('idle', { isViteDev: true })).toBe(false);
    expect(shouldShowRestartToUpdate('checking', { isViteDev: true })).toBe(false);
  });
});

describe('update ready / staging copy', () => {
  it('shows ready message only when install is prepared', () => {
    expect(
      shouldShowUpdateReadyMessage({
        status: 'ready',
        currentVersion: '1.0.0',
        version: '1.1.0',
        installPrepared: true,
      })
    ).toBe(true);
    expect(
      shouldShowUpdateReadyMessage({
        status: 'ready',
        currentVersion: '1.0.0',
        version: '1.1.0',
        installPrepared: false,
      })
    ).toBe(false);
  });

  it('shows preparing while Squirrel stages', () => {
    expect(
      isUpdateStagingForInstall({
        status: 'ready',
        currentVersion: '1.0.0',
        version: '1.1.0',
        installPrepared: false,
      })
    ).toBe(true);
  });
});
