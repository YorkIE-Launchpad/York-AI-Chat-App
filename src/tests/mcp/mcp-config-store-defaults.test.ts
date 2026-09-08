import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function registerStoreMocks(userDataPath: string): void {
  vi.doMock('electron', () => ({
    app: {
      isPackaged: false,
      getPath: (name: string) => {
        if (name !== 'userData') {
          throw new Error(`Unexpected path request: ${name}`);
        }
        return userDataPath;
      },
    },
  }));

  vi.doMock('electron-store', () => {
    class MockStore {
      private internalStore: Record<string, unknown>;
      private readonly defaults: Record<string, unknown>;

      constructor(options: { defaults?: Record<string, unknown> }) {
        this.defaults = { ...(options.defaults || {}) };
        this.internalStore = { ...this.defaults };
      }

      get(key: string, fallback?: unknown): unknown {
        if (Object.prototype.hasOwnProperty.call(this.internalStore, key)) {
          return this.internalStore[key];
        }
        return fallback;
      }

      set(key: string, value: unknown): void {
        this.internalStore[key] = value;
      }
    }

    return { default: MockStore };
  });
}

describe('MCPConfigStore default seeding', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-defaults-'));
    vi.resetModules();
    registerStoreMocks(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds every built-in MCP connector disabled on a fresh install', async () => {
    const { mcpConfigStore } = await import('../../main/mcp/mcp-config-store');

    const seeded = [
      mcpConfigStore.ensureDefaultChromeServer(),
      mcpConfigStore.ensureDefaultLaunchpadServer(),
      mcpConfigStore.ensureDefaultGtmLaunchpadServer(),
      mcpConfigStore.ensureDefaultRndPulseServer(),
      mcpConfigStore.ensureDefaultHubServer(),
      mcpConfigStore.ensureDefaultGtmPulseServer(),
      mcpConfigStore.ensureDefaultSlackServer(),
      mcpConfigStore.ensureDefaultGmailServer(),
      mcpConfigStore.ensureDefaultGoogleDriveServer(),
      mcpConfigStore.ensureDefaultJiraServer(),
      mcpConfigStore.ensureDefaultConfluenceServer(),
      mcpConfigStore.ensureDefaultGoogleCalendarServer(),
    ];

    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((server) => server.enabled === false)).toBe(true);
    expect(mcpConfigStore.getEnabledServers()).toEqual([]);
    expect(mcpConfigStore.getServers()).toHaveLength(seeded.length);
  });
});
