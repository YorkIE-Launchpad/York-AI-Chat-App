import Store, { type Options as StoreOptions } from 'electron-store';
import { app } from 'electron';
import * as fs from 'fs';
import * as crypto from 'crypto';
import path from 'path';
import type { MCPServerConfig } from './mcp-manager';
import { log, logError } from '../utils/logger';

/**
 * Built-in Chrome MCP connector — seeded enabled by default (not a Quick Add preset).
 */
export const DEFAULT_CHROME_MCP_SERVER: Omit<MCPServerConfig, 'id' | 'enabled'> = {
  name: 'Chrome',
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'chrome-devtools-mcp@latest', '--browser-url', 'http://localhost:9222'],
};

const DEFAULT_CHROME_SERVER_ID = 'mcp-chrome-default';

export function isChromeMcpServer(server: Pick<MCPServerConfig, 'name' | 'args'>): boolean {
  if (server.name.toLowerCase() === 'chrome') {
    return true;
  }
  return Boolean(server.args?.some((arg) => arg.includes('chrome-devtools-mcp')));
}

/**
 * Preset MCP Server Configurations
 * These are common MCP servers that users can quickly add
 */
export const MCP_SERVER_PRESETS: Record<
  string,
  Omit<MCPServerConfig, 'id' | 'enabled'> & {
    requiresEnv?: string[];
    envDescription?: Record<string, string>;
  }
> = {
  notion: {
    name: 'Notion',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: {
      NOTION_TOKEN: '',
    },
    requiresEnv: ['NOTION_TOKEN'],
    envDescription: {
      NOTION_TOKEN: 'Notion Internal Integration Token (get from notion.so/profile/integrations)',
    },
  },
  'software-development': {
    name: 'Software_Development',
    type: 'stdio',
    command: 'node',
    args: ['{SOFTWARE_DEV_SERVER_PATH}'], // Path will be resolved at runtime (compiled JS in production)
    env: {
      WORKSPACE_DIR: '',
      TEST_ENV: 'development',
    },
    requiresEnv: [],
    envDescription: {
      WORKSPACE_DIR: 'Workspace directory for code development (optional)',
      TEST_ENV: 'Test environment: development, staging, or production (optional)',
    },
  },
  'gui-operate': {
    name: 'GUI_Operate',
    type: 'stdio',
    command: 'node',
    args: ['{GUI_OPERATE_SERVER_PATH}'], // Path will be resolved at runtime (compiled JS in production)
    env: {},
    requiresEnv: [],
    envDescription: {
      // No environment variables required
    },
  },
};

/**
 * MCP Server Configuration Store
 */
class MCPConfigStore {
  private store: Store<{ servers: MCPServerConfig[] }>;

  constructor() {
    const storeOptions: StoreOptions<{ servers: MCPServerConfig[] }> & { projectName?: string } = {
      name: 'mcp-config',
      projectName: 'york-ie',
      defaults: {
        servers: [],
      },
    };

    this.store = new Store<{ servers: MCPServerConfig[] }>(storeOptions);
  }

  /**
   * Get all MCP server configurations
   */
  getServers(): MCPServerConfig[] {
    return this.store.get('servers', []);
  }

  /**
   * Get a specific server configuration
   */
  getServer(serverId: string): MCPServerConfig | undefined {
    const servers = this.getServers();
    return servers.find((s) => s.id === serverId);
  }

  /**
   * Add or update a server configuration
   */
  saveServer(config: MCPServerConfig): void {
    const servers = this.getServers();
    const index = servers.findIndex((s) => s.id === config.id);

    if (index >= 0) {
      servers[index] = config;
    } else {
      servers.push(config);
    }

    this.store.set('servers', servers);
  }

  /**
   * Delete a server configuration.
   * Built-in Chrome MCP cannot be removed.
   */
  deleteServer(serverId: string): boolean {
    const servers = this.getServers();
    const target = servers.find((s) => s.id === serverId);
    if (target && isChromeMcpServer(target)) {
      log('[MCPConfigStore] Refusing to delete built-in Chrome MCP connector');
      return false;
    }
    const filtered = servers.filter((s) => s.id !== serverId);
    this.store.set('servers', filtered);
    return true;
  }

  /**
   * Update all server configurations
   */
  setServers(servers: MCPServerConfig[]): void {
    this.store.set('servers', servers);
  }

  /**
   * Get enabled servers only
   */
  getEnabledServers(): MCPServerConfig[] {
    return this.getServers().filter((s) => s.enabled);
  }

  /**
   * Ensure the built-in Chrome MCP connector exists.
   * Does not re-enable or recreate if the user already has a Chrome connector
   * (including one they disabled or customized).
   */
  ensureDefaultChromeServer(): MCPServerConfig {
    const existing = this.getServers().find(isChromeMcpServer);
    if (existing) {
      return existing;
    }

    const chromeServer: MCPServerConfig = {
      ...DEFAULT_CHROME_MCP_SERVER,
      id: DEFAULT_CHROME_SERVER_ID,
      enabled: true,
    };
    this.saveServer(chromeServer);
    log('[MCPConfigStore] Seeded default Chrome MCP connector');
    return chromeServer;
  }

  /**
   * Get preset configurations
   */
  getPresets(): Record<string, Omit<MCPServerConfig, 'id' | 'enabled'>> {
    return MCP_SERVER_PRESETS;
  }

  /**
   * Get the path to a MCP server file in the mcp directory
   */
  private getMcpServerPath(filename: string): string | null {
    // In development: __dirname points to dist-electron/main
    // In production: appPath points to the app.asar or unpacked app
    if (app.isPackaged) {
      // Production: use compiled JavaScript files from extraResources/mcp
      // Convert .ts extension to .js
      const jsFilename = filename.replace(/\.ts$/, '.js');
      const mcpPath = path.join(process.resourcesPath || '', 'mcp', jsFilename);

      // Check if compiled JS file exists in resources
      try {
        if (fs.existsSync(mcpPath)) {
          return mcpPath;
        }
      } catch {
        // Fall through to development path
      }
    }

    // Development: __dirname is dist-electron/main
    // Need to go up 2 levels to get to project root (dist-electron/main -> dist-electron -> project root)
    const projectRoot = path.join(__dirname, '..', '..');

    // Prefer bundled JS from dist-mcp in development.
    // This avoids attempting to run TypeScript directly with `node`.
    const jsFilename = filename.replace(/\.ts$/, '.js');
    const devBundledPath = path.join(projectRoot, 'dist-mcp', jsFilename);
    try {
      if (fs.existsSync(devBundledPath)) {
        return devBundledPath;
      }
    } catch {
      // Fall through to source path
    }

    // Fallback: navigate to src/main/mcp/[filename]
    const sourcePath = path.join(projectRoot, 'src', 'main', 'mcp', filename);

    // Verify file exists and log for debugging
    try {
      if (fs.existsSync(sourcePath)) {
        log(`[MCPConfigStore] MCP Server path resolved (${filename}):`, sourcePath);
        return sourcePath;
      } else {
        logError(`[MCPConfigStore] File not found at:`, sourcePath);
        logError('[MCPConfigStore] __dirname:', __dirname);
        logError('[MCPConfigStore] projectRoot:', projectRoot);
      }
    } catch (error) {
      logError('[MCPConfigStore] Error checking file:', error);
    }

    return null;
  }

  /**
   * Get the path to the Software Development MCP server file
   */
  private getSoftwareDevServerPath(): string | null {
    return this.getMcpServerPath('software-dev-server-example.ts');
  }

  /**
   * Get the path to the GUI Operate MCP server file
   */
  private getGuiOperateServerPath(): string | null {
    return this.getMcpServerPath('gui-operate-server.ts');
  }

  /**
   * Create a server config from a preset
   */
  createFromPreset(presetKey: string, enabled: boolean = false): MCPServerConfig | null {
    const preset = MCP_SERVER_PRESETS[presetKey];
    if (!preset) {
      return null;
    }

    // Resolve path placeholders for presets
    let resolvedPreset = { ...preset };

    if (preset.args) {
      resolvedPreset = {
        ...preset,
        args: preset.args.map((arg) => {
          // Software Development server path
          if (arg === '{SOFTWARE_DEV_SERVER_PATH}') {
            return this.getSoftwareDevServerPath() || arg;
          }
          // GUI Operate server path
          if (arg === '{GUI_OPERATE_SERVER_PATH}') {
            return this.getGuiOperateServerPath() || arg;
          }
          return arg;
        }),
      };
    }

    return {
      ...resolvedPreset,
      id: `mcp-${presetKey}-${crypto.randomUUID()}`,
      enabled,
    };
  }
}

// Singleton instance
export const mcpConfigStore = new MCPConfigStore();
