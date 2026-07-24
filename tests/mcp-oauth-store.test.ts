import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function registerStoreMocks(userDataPath: string): void {
  vi.doMock('electron', () => ({
    app: {
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
      public path: string;
      private internalStore: Record<string, unknown>;
      private readonly encryptionKey?: string;
      private readonly defaults: Record<string, unknown>;

      constructor(options: {
        name?: string;
        defaults?: Record<string, unknown>;
        encryptionKey?: string;
      }) {
        const name = options.name || 'config';
        this.path = path.join(userDataPath, `${name}.json`);
        this.defaults = { ...(options.defaults || {}) };
        this.encryptionKey = options.encryptionKey;

        if (fs.existsSync(this.path)) {
          const raw = fs.readFileSync(this.path, 'utf8');
          const parsed = JSON.parse(raw) as {
            key?: string;
            payload?: Record<string, unknown>;
          };

          if (parsed.key && parsed.key !== this.encryptionKey) {
            throw new SyntaxError('Unexpected token \'�\', "�..." is not valid JSON');
          }

          this.internalStore = {
            ...this.defaults,
            ...(parsed.payload || {}),
          };
          return;
        }

        this.internalStore = { ...this.defaults };
      }

      get(key: string): unknown {
        return this.internalStore[key];
      }

      set(key: string, value: unknown): void {
        this.internalStore[key] = value;
        fs.writeFileSync(
          this.path,
          JSON.stringify({
            key: this.encryptionKey,
            payload: this.internalStore,
          })
        );
      }

      get store(): Record<string, unknown> {
        return this.internalStore;
      }

      set store(value: Record<string, unknown>) {
        this.internalStore = value;
        fs.writeFileSync(
          this.path,
          JSON.stringify({
            key: this.encryptionKey,
            payload: value,
          })
        );
      }
    }

    return {
      default: MockStore,
    };
  });

  vi.doMock('../src/main/utils/logger', () => ({
    log: vi.fn(),
    logWarn: vi.fn(),
  }));
}

describe('mcpOAuthStore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'york-ie-mcp-oauth-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock('electron');
    vi.doUnmock('electron-store');
    vi.doUnmock('../src/main/utils/logger');
  });

  it('saves and loads OAuth records by server id', async () => {
    registerStoreMocks(tempDir);

    const { mcpOAuthStore } = await import('../src/main/mcp/mcp-oauth-store');
    const record = {
      serverUrl: 'https://gtm-pulse.example.com/mcp',
      clientInformation: { client_id: 'client-1' },
      tokens: { access_token: 'token-1', token_type: 'Bearer' },
      redirectUrl: 'http://127.0.0.1:3000/callback',
    };

    mcpOAuthStore.save('gtm-pulse', record);

    expect(mcpOAuthStore.load('gtm-pulse', 'https://gtm-pulse.example.com/mcp')).toEqual(record);
  });

  it('clears stored credentials when the server URL changes', async () => {
    registerStoreMocks(tempDir);

    const { mcpOAuthStore } = await import('../src/main/mcp/mcp-oauth-store');
    mcpOAuthStore.save('gtm-pulse', {
      serverUrl: 'https://old.example.com/mcp',
      tokens: { access_token: 'token-1', token_type: 'Bearer' },
    });

    expect(mcpOAuthStore.load('gtm-pulse', 'https://new.example.com/mcp')).toBeNull();
    expect(mcpOAuthStore.load('gtm-pulse', 'https://old.example.com/mcp')).toBeNull();
  });

  it('clears stored credentials for a server id', async () => {
    registerStoreMocks(tempDir);

    const { mcpOAuthStore } = await import('../src/main/mcp/mcp-oauth-store');
    mcpOAuthStore.save('gtm-pulse', {
      serverUrl: 'https://gtm-pulse.example.com/mcp',
      tokens: { access_token: 'token-1', token_type: 'Bearer' },
    });

    mcpOAuthStore.clear('gtm-pulse');

    expect(mcpOAuthStore.load('gtm-pulse', 'https://gtm-pulse.example.com/mcp')).toBeNull();
  });
});
