import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), exit: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn() },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { ScreenRecordingPermission } from '../../main/snap/screen-permission';

function setup(options: { status?: string; confirm?: boolean } = {}) {
  const state = { status: options.status ?? 'denied', time: 0 };
  let tick: (() => void) | null = null;
  const deps = {
    getStatus: vi.fn(() => state.status),
    requestNative: vi.fn(async () => undefined),
    confirm: vi.fn(async () => options.confirm ?? true),
    openSettings: vi.fn(async () => undefined),
    relaunch: vi.fn(),
    setInterval: vi.fn((fn: () => void) => {
      tick = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }),
    clearInterval: vi.fn(() => {
      tick = null;
    }),
    now: () => state.time,
  };
  const permission = new ScreenRecordingPermission(deps);
  return { permission, deps, state, tick: () => tick?.(), hasTimer: () => tick !== null };
}

describe('ScreenRecordingPermission', () => {
  it('proceeds immediately when already granted', async () => {
    const { permission, deps } = setup({ status: 'granted' });
    await expect(permission.ensure()).resolves.toBe(true);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.openSettings).not.toHaveBeenCalled();
  });

  it('asks first, then requests access, opens Settings and waits', async () => {
    const { permission, deps, hasTimer } = setup();
    await expect(permission.ensure()).resolves.toBe(false);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.requestNative).toHaveBeenCalledTimes(1);
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
    expect(hasTimer()).toBe(true);
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('does nothing when the user declines', async () => {
    const { permission, deps, hasTimer } = setup({ confirm: false });
    await expect(permission.ensure()).resolves.toBe(false);
    expect(deps.requestNative).not.toHaveBeenCalled();
    expect(deps.openSettings).not.toHaveBeenCalled();
    expect(hasTimer()).toBe(false);
  });

  it('relaunches the app once access is granted', async () => {
    const { permission, deps, state, tick, hasTimer } = setup();
    await permission.ensure();
    tick();
    expect(deps.relaunch).not.toHaveBeenCalled();
    state.status = 'granted';
    tick();
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(hasTimer()).toBe(false);
  });

  it('proceeds without Settings when the native prompt grants access right away', async () => {
    const { permission, deps, state } = setup();
    deps.requestNative.mockImplementation(async () => {
      state.status = 'granted';
    });
    await expect(permission.ensure()).resolves.toBe(true);
    expect(deps.openSettings).not.toHaveBeenCalled();
  });

  it('reopens Settings without asking again while waiting', async () => {
    const { permission, deps } = setup();
    await permission.ensure();
    await permission.ensure();
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.openSettings).toHaveBeenCalledTimes(2);
  });

  it('stops waiting after the timeout', async () => {
    const { permission, deps, state, tick, hasTimer } = setup();
    await permission.ensure();
    state.time = 10 * 60 * 1000;
    tick();
    expect(hasTimer()).toBe(false);
    expect(deps.relaunch).not.toHaveBeenCalled();
  });
});
