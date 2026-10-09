import { beforeEach, describe, expect, it, vi } from 'vitest';

const persisted = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/growthos-test' },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../main/utils/store-encryption', () => ({
  getLegacyDerivedKeyHexes: () => [],
  createEncryptedStoreWithKeyRotation: (opts: {
    storeOptions: { defaults: Record<string, unknown> };
  }) => {
    if (Object.keys(persisted.data).length === 0) {
      persisted.data = { ...opts.storeOptions.defaults };
    }
    return {
      get store() {
        return persisted.data;
      },
      get: (key: string) => persisted.data[key],
      set: (value: Record<string, unknown>) => {
        persisted.data = { ...value };
      },
      clear: () => {
        persisted.data = {};
      },
      path: '/tmp/growthos-test/config.json',
    };
  },
}));

import { ConfigStore } from '../../main/config/config-store';

describe('Screen Snap config persistence', () => {
  beforeEach(() => {
    persisted.data = {};
  });

  it('keeps a changed shortcut and mode across restarts', () => {
    const first = new ConfigStore();
    expect(first.get('screenSnapShortcut')).toBe('CommandOrControl+Shift+G');

    first.update({ screenSnapShortcut: 'Control+Option+S', screenSnapMode: 'write' });

    const afterRestart = new ConfigStore();
    expect(afterRestart.get('screenSnapShortcut')).toBe('Control+Option+S');
    expect(afterRestart.get('screenSnapMode')).toBe('write');
  });

  it('keeps a disabled shortcut (null) across restarts', () => {
    new ConfigStore().update({ screenSnapShortcut: null });
    expect(new ConfigStore().get('screenSnapShortcut')).toBeNull();
  });

  it('does not reset the shortcut when other settings change', () => {
    const store = new ConfigStore();
    store.update({ screenSnapShortcut: 'Control+Option+S' });
    store.update({ theme: 'dark' });
    expect(new ConfigStore().get('screenSnapShortcut')).toBe('Control+Option+S');
  });
});
