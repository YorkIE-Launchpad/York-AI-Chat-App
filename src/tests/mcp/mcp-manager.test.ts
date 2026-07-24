/**
 * Tests for MCPManager connection timeout and status tracking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// electron is aliased to tests/mocks/electron.ts via vitest.config.mts (includes default export)

// Mock logger to suppress output during tests
vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logCtx: vi.fn(),
  logCtxError: vi.fn(),
  logTiming: vi.fn(),
}));

// Mock shell-resolver
vi.mock('../../main/utils/shell-resolver', () => ({
  getDefaultShell: () => '/bin/bash',
}));

import { MCPManager } from '../../main/mcp/mcp-manager';
import type { MCPServerConfig } from '../../main/mcp/mcp-manager';

type TestMCPClient = {
  listTools?: () => Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }>;
  callTool?: (input: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
};

type TestManagerInternals = {
  clients: Map<string, TestMCPClient>;
  tools: Map<string, unknown>;
  serverConfigs: Map<string, MCPServerConfig>;
  connectionStatus: Map<string, 'connecting' | 'connected' | 'failed'>;
  connectRetryControllers: Map<string, AbortController>;
  reconnectServer?: (serverId: string, options?: { skipRefresh?: boolean }) => Promise<boolean>;
  startConnectRetryLoop: (config: MCPServerConfig) => void;
};

function asTestManager(manager: MCPManager): TestManagerInternals {
  return manager as unknown as TestManagerInternals;
}

describe('MCPManager', () => {
  let manager: MCPManager;

  beforeEach(() => {
    manager = new MCPManager();
  });

  describe('getServerStatus()', () => {
    it('returns disabled status for disabled servers', async () => {
      const configs: MCPServerConfig[] = [
        {
          id: 'test-1',
          name: 'Test Server',
          type: 'stdio',
          command: 'echo',
          args: ['hello'],
          enabled: false,
        },
      ];

      await manager.initializeServers(configs);
      const statuses = manager.getServerStatus();

      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({
        id: 'test-1',
        name: 'Test Server',
        connected: false,
        status: 'disabled',
        toolCount: 0,
      });
    });

    it('starts connect retry and shows connecting when connection fails', async () => {
      const configs: MCPServerConfig[] = [
        {
          id: 'test-fail',
          name: 'Failing Server',
          type: 'sse',
          url: 'http://127.0.0.1:1/nonexistent',
          enabled: true,
        },
      ];

      // initializeServers catches errors internally, so this should not throw
      await manager.initializeServers(configs);
      const statuses = manager.getServerStatus();

      expect(statuses).toHaveLength(1);
      expect(statuses[0].id).toBe('test-fail');
      expect(statuses[0].status).toBe('connecting');
      expect(statuses[0].connected).toBe(false);

      await manager.disconnectServer('test-fail');
    });

    it('includes status field in all returned statuses', async () => {
      const configs: MCPServerConfig[] = [
        {
          id: 'disabled-server',
          name: 'Disabled',
          type: 'stdio',
          command: 'echo',
          enabled: false,
        },
        {
          id: 'enabled-server',
          name: 'Enabled',
          type: 'sse',
          url: 'http://127.0.0.1:1/bad',
          enabled: true,
        },
      ];

      await manager.initializeServers(configs);
      const statuses = manager.getServerStatus();

      expect(statuses).toHaveLength(2);
      for (const s of statuses) {
        expect(s).toHaveProperty('status');
        expect(['connecting', 'connected', 'failed', 'disabled']).toContain(s.status);
      }
    });

    it('returns empty array when no servers configured', () => {
      const statuses = manager.getServerStatus();
      expect(statuses).toEqual([]);
    });
  });

  describe('connection timeout', () => {
    it('shows connecting while connect retry is in progress', async () => {
      const config: MCPServerConfig = {
        id: 'timeout-test',
        name: 'Timeout Test',
        type: 'sse',
        url: 'http://127.0.0.1:1/timeout-test',
        enabled: true,
      };

      await manager.initializeServers([config]);
      const statuses = manager.getServerStatus();

      const serverStatus = statuses.find((s) => s.id === 'timeout-test');
      expect(serverStatus).toBeDefined();
      expect(serverStatus!.status).toBe('connecting');
      expect(serverStatus!.connected).toBe(false);

      await manager.disconnectServer('timeout-test');
    });

    it('waits five minutes before timing out listTools for slow MCP servers', async () => {
      vi.useFakeTimers();
      const testManager = asTestManager(manager);
      const mockClient: TestMCPClient = {
        listTools: vi.fn(
          () =>
            new Promise<{
              tools: Array<{
                name: string;
                inputSchema: { type: string; properties: Record<string, never> };
              }>;
            }>(() => {})
        ),
      };
      testManager.clients = new Map([['slow-server', mockClient]]);
      testManager.serverConfigs = new Map([
        [
          'slow-server',
          {
            id: 'slow-server',
            name: 'Slow Server',
            type: 'stdio',
            command: 'slow-server',
            enabled: true,
          },
        ],
      ]);

      let settled = false;
      const refreshPromise = manager.refreshTools().then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(299999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await refreshPromise;

      expect(settled).toBe(true);
      expect(mockClient.listTools).toHaveBeenCalledTimes(1);
      expect(manager.getTools()).toEqual([]);
      vi.useRealTimers();
    });

    it('does not let a slow server block fast server tool discovery', async () => {
      vi.useFakeTimers();
      const testManager = asTestManager(manager);
      const slowClient: TestMCPClient = {
        listTools: vi.fn(
          () =>
            new Promise<{
              tools: Array<{
                name: string;
                inputSchema: { type: string; properties: Record<string, never> };
              }>;
            }>(() => {})
        ),
      };
      const fastClient: TestMCPClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'inspect',
              description: 'Fast tool',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        }),
      };

      testManager.clients = new Map([
        ['slow-server', slowClient],
        ['fast-server', fastClient],
      ]);
      testManager.serverConfigs = new Map([
        [
          'slow-server',
          {
            id: 'slow-server',
            name: 'Slow Server',
            type: 'stdio',
            command: 'slow-server',
            enabled: true,
          },
        ],
        [
          'fast-server',
          {
            id: 'fast-server',
            name: 'Fast Server',
            type: 'stdio',
            command: 'fast-server',
            enabled: true,
          },
        ],
      ]);

      const refreshPromise = manager.refreshTools();
      await Promise.resolve();

      expect(manager.getTools()).toEqual([]);

      await vi.advanceTimersByTimeAsync(300000);
      await refreshPromise;

      expect(fastClient.listTools).toHaveBeenCalledTimes(1);
      expect(slowClient.listTools).toHaveBeenCalledTimes(1);
      expect(manager.getTools()).toEqual([
        {
          name: 'mcp__Fast_Server__inspect',
          originalName: 'inspect',
          description: 'Fast tool',
          inputSchema: { type: 'object', properties: {}, required: undefined },
          serverId: 'fast-server',
          serverName: 'Fast Server',
        },
      ]);
      vi.useRealTimers();
    });

    it('applies a shared five-minute deadline across tool-call retries', async () => {
      vi.useFakeTimers();
      const testManager = asTestManager(manager);
      const mockClient: TestMCPClient = {
        callTool: vi.fn(() => new Promise<unknown>(() => {})),
      };
      testManager.clients = new Map([['server-1', mockClient]]);
      testManager.tools = new Map([
        [
          'mcp__Slow_Server__inspect',
          {
            name: 'mcp__Slow_Server__inspect',
            description: '',
            inputSchema: { type: 'object', properties: {} },
            serverId: 'server-1',
            serverName: 'Slow Server',
          },
        ],
      ]);

      const callPromise = manager.callTool('mcp__Slow_Server__inspect', { pid: 1234 });

      await vi.advanceTimersByTimeAsync(299999);
      let settled = false;
      callPromise.catch(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(callPromise).rejects.toThrow('Tool call timeout after 300000ms');
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  describe('refreshTools()', () => {
    it('reconnects and retries listTools when server returns Not connected', async () => {
      const testManager = asTestManager(manager);
      const mockClientAfterReconnect: TestMCPClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'get_pulse',
              description: 'Get GTM pulse data',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        }),
      };
      const mockClient: TestMCPClient = {
        listTools: vi.fn().mockRejectedValue(new Error('Not connected')),
      };

      testManager.clients = new Map([['mcp-gtm-pulse-default', mockClient]]);
      testManager.serverConfigs = new Map([
        [
          'mcp-gtm-pulse-default',
          {
            id: 'mcp-gtm-pulse-default',
            name: 'GTM Pulse',
            type: 'streamable-http',
            url: 'https://gtm-pulse.yorkdevs.link/mcp',
            enabled: true,
          },
        ],
      ]);
      testManager.reconnectServer = vi.fn().mockImplementation(async (serverId: string) => {
        testManager.clients.set(serverId, mockClientAfterReconnect);
        return true;
      });

      await manager.refreshTools();

      expect(testManager.reconnectServer).toHaveBeenCalledWith('mcp-gtm-pulse-default', {
        skipRefresh: true,
      });
      expect(mockClient.listTools).toHaveBeenCalledTimes(1);
      expect(mockClientAfterReconnect.listTools).toHaveBeenCalledTimes(1);
      expect(manager.getTools()).toEqual([
        {
          name: 'mcp__GTM_Pulse__get_pulse',
          originalName: 'get_pulse',
          description: 'Get GTM pulse data',
          inputSchema: { type: 'object', properties: {}, required: undefined },
          serverId: 'mcp-gtm-pulse-default',
          serverName: 'GTM Pulse',
        },
      ]);
    });

    it('does not reconnect on non-reconnectable listTools errors', async () => {
      const testManager = asTestManager(manager);
      const mockClient: TestMCPClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools timeout after 300000ms')),
      };

      testManager.clients = new Map([['slow-server', mockClient]]);
      testManager.serverConfigs = new Map([
        [
          'slow-server',
          {
            id: 'slow-server',
            name: 'Slow Server',
            type: 'stdio',
            command: 'slow-server',
            enabled: true,
          },
        ],
      ]);
      testManager.reconnectServer = vi.fn().mockResolvedValue(true);

      await manager.refreshTools();

      expect(testManager.reconnectServer).not.toHaveBeenCalled();
      expect(mockClient.listTools).toHaveBeenCalledTimes(1);
      expect(manager.getTools()).toEqual([]);
    });
  });

  describe('connect retry on failure', () => {
    const retryConfig: MCPServerConfig = {
      id: 'retry-server',
      name: 'Retry Server',
      type: 'sse',
      url: 'http://127.0.0.1:1/retry',
      enabled: true,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      const testManager = asTestManager(manager);
      testManager.serverConfigs.set(retryConfig.id, retryConfig);
    });

    afterEach(async () => {
      await manager.disconnectServer(retryConfig.id);
      vi.useRealTimers();
    });

    it('retries every 5s and succeeds before the 5 minute deadline', async () => {
      const testManager = asTestManager(manager);
      let attempts = 0;
      testManager.reconnectServer = vi.fn().mockImplementation(async (serverId: string) => {
        attempts++;
        if (attempts >= 2) {
          testManager.clients.set(serverId, {
            listTools: vi.fn().mockResolvedValue({ tools: [] }),
          });
          testManager.connectionStatus.set(serverId, 'connected');
          return true;
        }
        return false;
      });

      testManager.startConnectRetryLoop(retryConfig);

      expect(manager.getServerStatus()[0].status).toBe('connecting');

      await vi.advanceTimersByTimeAsync(5000);
      expect(testManager.reconnectServer).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();

      expect(testManager.reconnectServer).toHaveBeenCalledTimes(2);
      expect(manager.getServerStatus()[0].status).toBe('connected');
      expect(testManager.connectRetryControllers.has(retryConfig.id)).toBe(false);
    });

    it('gives up after 5 minutes and marks status failed', async () => {
      const testManager = asTestManager(manager);
      testManager.reconnectServer = vi.fn().mockResolvedValue(false);

      testManager.startConnectRetryLoop(retryConfig);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5000);
      await Promise.resolve();

      expect(testManager.reconnectServer).toHaveBeenCalledTimes(60);
      expect(manager.getServerStatus()[0].status).toBe('failed');
    });

    it('stops retrying when the server is disconnected', async () => {
      const testManager = asTestManager(manager);
      testManager.reconnectServer = vi.fn().mockResolvedValue(false);

      testManager.startConnectRetryLoop(retryConfig);

      await vi.advanceTimersByTimeAsync(5000);
      expect(testManager.reconnectServer).toHaveBeenCalledTimes(1);

      await manager.disconnectServer(retryConfig.id);

      await vi.advanceTimersByTimeAsync(60000);
      await Promise.resolve();

      expect(testManager.reconnectServer).toHaveBeenCalledTimes(1);
      expect(testManager.connectRetryControllers.has(retryConfig.id)).toBe(false);
    });

    it('stops retrying when the server is disabled', async () => {
      const testManager = asTestManager(manager);
      testManager.reconnectServer = vi.fn().mockResolvedValue(false);

      testManager.startConnectRetryLoop(retryConfig);

      await vi.advanceTimersByTimeAsync(5000);
      expect(testManager.reconnectServer).toHaveBeenCalledTimes(1);

      await manager.updateServer({ ...retryConfig, enabled: false });

      await vi.advanceTimersByTimeAsync(60000);
      await Promise.resolve();

      expect(testManager.reconnectServer).toHaveBeenCalledTimes(1);
      expect(testManager.connectRetryControllers.has(retryConfig.id)).toBe(false);
    });
  });

  describe('disconnectServer()', () => {
    it('removes connection status when disconnecting', async () => {
      const configs: MCPServerConfig[] = [
        {
          id: 'disc-test',
          name: 'Disconnect Test',
          type: 'sse',
          url: 'http://127.0.0.1:1/bad',
          enabled: true,
        },
      ];

      await manager.initializeServers(configs);

      // Server should be in connecting state while retry loop runs
      let statuses = manager.getServerStatus();
      expect(statuses[0].status).toBe('connecting');

      // After disconnect, status entry is removed; enabled server with no tracked status
      // falls back to 'connecting' (transient state)
      await manager.disconnectServer('disc-test');
      statuses = manager.getServerStatus();
      expect(statuses[0].status).toBe('connecting');
    });
  });
});
