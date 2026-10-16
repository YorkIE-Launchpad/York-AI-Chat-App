import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../main/utils/store-encryption', () => ({
  getLegacyDerivedKeyHexes: () => [],
  createEncryptedStoreWithKeyRotation: <T extends Record<string, unknown>>(options: {
    storeOptions: { defaults: T };
  }) => {
    const data = { ...options.storeOptions.defaults } as T;
    return {
      get: (key: string, fallback?: unknown) => {
        const parts = key.split('.');
        let cur: unknown = data;
        for (const part of parts) {
          if (cur == null || typeof cur !== 'object') return fallback;
          cur = (cur as Record<string, unknown>)[part];
        }
        return cur === undefined ? fallback : cur;
      },
      set: (key: string, value: unknown) => {
        const parts = key.split('.');
        let cur = data as Record<string, unknown>;
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {};
          cur = cur[part] as Record<string, unknown>;
        }
        cur[parts[parts.length - 1]] = value;
      },
      delete: (key: string) => {
        const parts = key.split('.');
        let cur = data as Record<string, unknown>;
        for (let i = 0; i < parts.length - 1; i++) {
          cur = (cur[parts[i]] as Record<string, unknown>) ?? {};
        }
        delete cur[parts[parts.length - 1]];
      },
      clear: () => {
        for (const key of Object.keys(data)) delete (data as Record<string, unknown>)[key];
      },
      path: path.join(os.tmpdir(), 'remote-config-test.json'),
    };
  },
}));

describe('Slack relay connection log', () => {
  let storePath: string;

  beforeEach(() => {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-relay-log-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('appends newest-first events with hostname and caps the list', async () => {
    const { remoteConfigStore } = await import('../../main/remote/remote-config-store');
    const { SLACK_RELAY_CONNECTION_LOG_MAX } = await import('../../main/remote/types');

    for (let i = 0; i < SLACK_RELAY_CONNECTION_LOG_MAX + 5; i++) {
      remoteConfigStore.appendSlackRelayConnectionEvent('connected', `event-${i}`);
    }

    const log = remoteConfigStore.getSlackRelayConnectionLog();
    expect(log).toHaveLength(SLACK_RELAY_CONNECTION_LOG_MAX);
    expect(log[0]?.detail).toBe(`event-${SLACK_RELAY_CONNECTION_LOG_MAX + 4}`);
    expect(log[0]?.hostname).toBe(os.hostname());
    expect(log[0]?.kind).toBe('connected');
    expect(typeof log[0]?.id).toBe('string');
    expect(typeof log[0]?.at).toBe('number');
  });

  it('clears the connection log', async () => {
    const { remoteConfigStore } = await import('../../main/remote/remote-config-store');
    remoteConfigStore.appendSlackRelayConnectionEvent('enabled');
    expect(remoteConfigStore.getSlackRelayConnectionLog()).toHaveLength(1);
    remoteConfigStore.clearSlackRelayConnectionLog();
    expect(remoteConfigStore.getSlackRelayConnectionLog()).toEqual([]);
  });
});
