import Store, { type Options as StoreOptions } from 'electron-store';
import { app } from 'electron';
import * as fs from 'fs';
import * as crypto from 'crypto';
import path from 'path';
import type { MCPServerConfig } from './mcp-manager';
import { authConfig } from '../../shared/auth-config';
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
 * Built-in Launchpad MCP connector — seeded enabled by default (not a Quick Add preset).
 * Uses mcp-remote over stdio. Cognito access token is injected at connect time.
 * Default URL is production LaunchPad MCP (UAT rejects Host header today).
 */
export function getDefaultLaunchpadMcpUrl(): string {
  return authConfig.launchpadMcpUrl;
}

/** @deprecated Use getDefaultLaunchpadMcpUrl() — kept for call sites that need a snapshot. */
export const DEFAULT_LAUNCHPAD_MCP_URL = getDefaultLaunchpadMcpUrl();

/** Display name for the built-in Launchpad connector. */
export const DEFAULT_LAUNCHPAD_MCP_NAME = 'R&D Launchpad';

export function buildDefaultLaunchpadMcpServer(): Omit<MCPServerConfig, 'id' | 'enabled'> {
  return {
    name: DEFAULT_LAUNCHPAD_MCP_NAME,
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-remote', getDefaultLaunchpadMcpUrl()],
  };
}

export const DEFAULT_LAUNCHPAD_MCP_SERVER: Omit<MCPServerConfig, 'id' | 'enabled'> =
  buildDefaultLaunchpadMcpServer();

const DEFAULT_LAUNCHPAD_SERVER_ID = 'mcp-launchpad-default';

function normalizeMcpServerNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isLaunchpadHost(value: string | undefined): boolean {
  if (!value) return false;
  return /launchpad\.yorkdevs\.link/i.test(value);
}

function isLaunchpadServerName(name: string): boolean {
  const key = normalizeMcpServerNameKey(name);
  return key === 'launchpad' || key === 'rdlaunchpad';
}

export function isLaunchpadMcpServer(
  server: Pick<MCPServerConfig, 'name' | 'args' | 'url' | 'type'>
): boolean {
  if (isLaunchpadServerName(server.name)) {
    return true;
  }
  if (isLaunchpadHost(server.url)) {
    return true;
  }
  const args = server.args ?? [];
  const hasMcpRemote = args.some((arg) => arg.includes('mcp-remote'));
  const hasLaunchpadUrl = args.some((arg) => isLaunchpadHost(arg));
  return hasMcpRemote && hasLaunchpadUrl;
}

/**
 * Built-in Hub MCP connector — seeded enabled by default (not a Quick Add preset).
 * Uses streamable HTTP. Cognito bearer token is injected at connect time (no MCP OAuth).
 */
export function getDefaultHubMcpUrl(): string {
  return authConfig.hubMcpUrl;
}

/** Display name for the built-in Hub connector. */
export const DEFAULT_HUB_MCP_NAME = 'York IE HUB';

export function buildDefaultHubMcpServer(): Omit<MCPServerConfig, 'id' | 'enabled'> {
  return {
    name: DEFAULT_HUB_MCP_NAME,
    type: 'streamable-http',
    url: getDefaultHubMcpUrl(),
  };
}

export const DEFAULT_HUB_MCP_SERVER: Omit<MCPServerConfig, 'id' | 'enabled'> =
  buildDefaultHubMcpServer();

const DEFAULT_HUB_SERVER_ID = 'mcp-hub-default';

function isHubHost(value: string | undefined): boolean {
  if (!value) return false;
  // UAT/dev hosts (*.hub.yorkdevs.link) and prod (*.hub.york.ie)
  return /hub\.yorkdevs\.link/i.test(value) || /hub\.york\.ie/i.test(value);
}

function isHubServerName(name: string): boolean {
  const key = normalizeMcpServerNameKey(name);
  return key === 'hub' || key === 'yorkiehub';
}

export function isHubMcpServer(
  server: Pick<MCPServerConfig, 'name' | 'args' | 'url' | 'type'>
): boolean {
  if (isHubServerName(server.name)) {
    return true;
  }
  if (isHubHost(server.url)) {
    return true;
  }
  const args = server.args ?? [];
  const hasMcpRemote = args.some((arg) => arg.includes('mcp-remote'));
  const hasHubUrl = args.some((arg) => isHubHost(arg));
  return hasMcpRemote && hasHubUrl;
}

/**
 * Built-in GTM Pulse MCP connector — seeded enabled by default (not a Quick Add preset).
 * Uses streamable HTTP. Browser MCP OAuth is used at connect time.
 */
export function getDefaultGtmPulseMcpUrl(): string {
  return authConfig.gtmPulseMcpUrl;
}

export function buildDefaultGtmPulseMcpServer(): Omit<MCPServerConfig, 'id' | 'enabled'> {
  return {
    name: 'GTM Pulse',
    type: 'streamable-http',
    url: getDefaultGtmPulseMcpUrl(),
  };
}

export const DEFAULT_GTM_PULSE_MCP_SERVER: Omit<MCPServerConfig, 'id' | 'enabled'> =
  buildDefaultGtmPulseMcpServer();

const DEFAULT_GTM_PULSE_SERVER_ID = 'mcp-gtm-pulse-default';

function isGtmPulseHost(value: string | undefined): boolean {
  if (!value) return false;
  return /gtm-pulse\.yorkdevs\.link/i.test(value);
}

export function isGtmPulseMcpServer(
  server: Pick<MCPServerConfig, 'name' | 'args' | 'url' | 'type'>
): boolean {
  const normalizedName = server.name.toLowerCase().replace(/\s+/g, '-');
  if (normalizedName === 'gtm-pulse' || normalizedName === 'gtm pulse') {
    return true;
  }
  if (isGtmPulseHost(server.url)) {
    return true;
  }
  const args = server.args ?? [];
  const hasMcpRemote = args.some((arg) => arg.includes('mcp-remote'));
  const hasGtmPulseUrl = args.some((arg) => isGtmPulseHost(arg));
  return hasMcpRemote && hasGtmPulseUrl;
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
   * Built-in Chrome / Launchpad / Hub / GTM Pulse MCP cannot be removed.
   */
  deleteServer(serverId: string): boolean {
    const servers = this.getServers();
    const target = servers.find((s) => s.id === serverId);
    if (target && isChromeMcpServer(target)) {
      log('[MCPConfigStore] Refusing to delete built-in Chrome MCP connector');
      return false;
    }
    if (target && isLaunchpadMcpServer(target)) {
      log('[MCPConfigStore] Refusing to delete built-in Launchpad MCP connector');
      return false;
    }
    if (target && isHubMcpServer(target)) {
      log('[MCPConfigStore] Refusing to delete built-in Hub MCP connector');
      return false;
    }
    if (target && isGtmPulseMcpServer(target)) {
      log('[MCPConfigStore] Refusing to delete built-in GTM Pulse MCP connector');
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
   * Ensure the built-in Launchpad MCP connector exists.
   * Does not re-enable or recreate if the user already has a Launchpad connector
   * (including one they disabled or customized).
   * Migrates the built-in default to current Hub-matched mcp-remote URL + stdio.
   */
  ensureDefaultLaunchpadServer(): MCPServerConfig {
    const desiredUrl = getDefaultLaunchpadMcpUrl();
    const desired = buildDefaultLaunchpadMcpServer();
    const existing = this.getServers().find(isLaunchpadMcpServer);
    if (existing) {
      const needsMigration =
        existing.id === DEFAULT_LAUNCHPAD_SERVER_ID &&
        (existing.name !== desired.name ||
          existing.type !== 'stdio' ||
          existing.command !== 'npx' ||
          !existing.args?.includes('mcp-remote') ||
          !existing.args?.includes(desiredUrl));
      if (needsMigration) {
        const migrated: MCPServerConfig = {
          id: existing.id,
          enabled: existing.enabled,
          ...desired,
        };
        this.saveServer(migrated);
        log(`[MCPConfigStore] Migrated built-in Launchpad MCP to ${desired.name} @ ${desiredUrl}`);
        return migrated;
      }
      return existing;
    }

    const launchpadServer: MCPServerConfig = {
      ...desired,
      id: DEFAULT_LAUNCHPAD_SERVER_ID,
      enabled: true,
    };
    this.saveServer(launchpadServer);
    log(`[MCPConfigStore] Seeded default Launchpad MCP connector at ${desiredUrl}`);
    return launchpadServer;
  }

  /**
   * Ensure the built-in Hub MCP connector exists.
   * Does not re-enable or recreate if the user already has a Hub connector
   * (including one they disabled or customized).
   * Migrates the built-in default to streamable-http + current Hub MCP URL.
   */
  ensureDefaultHubServer(): MCPServerConfig {
    const desiredUrl = getDefaultHubMcpUrl();
    const desired = buildDefaultHubMcpServer();
    const existing = this.getServers().find(isHubMcpServer);
    if (existing) {
      const needsMigration =
        existing.id === DEFAULT_HUB_SERVER_ID &&
        (existing.name !== desired.name ||
          existing.type !== 'streamable-http' ||
          existing.url !== desiredUrl);
      if (needsMigration) {
        const migrated: MCPServerConfig = {
          id: existing.id,
          enabled: existing.enabled,
          ...desired,
        };
        this.saveServer(migrated);
        log(
          `[MCPConfigStore] Migrated built-in Hub MCP to ${desired.name} streamable-http ${desiredUrl}`
        );
        return migrated;
      }
      return existing;
    }

    const hubServer: MCPServerConfig = {
      ...desired,
      id: DEFAULT_HUB_SERVER_ID,
      enabled: true,
    };
    this.saveServer(hubServer);
    log(`[MCPConfigStore] Seeded default Hub MCP connector at ${desiredUrl}`);
    return hubServer;
  }

  /**
   * Ensure the built-in GTM Pulse MCP connector exists.
   * Does not re-enable or recreate if the user already has a GTM Pulse connector
   * (including one they disabled or customized).
   * Migrates the built-in default to streamable-http + current GTM Pulse MCP URL.
   */
  ensureDefaultGtmPulseServer(): MCPServerConfig {
    const desiredUrl = getDefaultGtmPulseMcpUrl();
    const desired = buildDefaultGtmPulseMcpServer();
    const existing = this.getServers().find(isGtmPulseMcpServer);
    if (existing) {
      const needsMigration =
        existing.id === DEFAULT_GTM_PULSE_SERVER_ID &&
        (existing.type !== 'streamable-http' || existing.url !== desiredUrl);
      if (needsMigration) {
        const migrated: MCPServerConfig = {
          id: existing.id,
          enabled: existing.enabled,
          ...desired,
        };
        this.saveServer(migrated);
        log(`[MCPConfigStore] Migrated built-in GTM Pulse MCP to streamable-http ${desiredUrl}`);
        return migrated;
      }
      return existing;
    }

    const gtmPulseServer: MCPServerConfig = {
      ...desired,
      id: DEFAULT_GTM_PULSE_SERVER_ID,
      enabled: true,
    };
    this.saveServer(gtmPulseServer);
    log(`[MCPConfigStore] Seeded default GTM Pulse MCP connector at ${desiredUrl}`);
    return gtmPulseServer;
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
