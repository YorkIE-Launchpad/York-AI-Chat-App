/**
 * Disk cache of the last successful MCP tool catalog.
 * Startup can expose tools immediately and reconnect in the background.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { Tool } from '@modelcontextprotocol/client';
import { logWarn } from '../utils/logger';

export interface CachedMcpTool {
  name: string;
  originalName?: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  outputSchema?: Tool['outputSchema'];
  toolDefinition: Tool;
  serverId: string;
  serverName: string;
}

interface CachedServerCatalog {
  fingerprint: string;
  tools: CachedMcpTool[];
  savedAt: number;
}

interface CatalogFile {
  version: 1;
  servers: Record<string, CachedServerCatalog>;
}

const EMPTY_CATALOG: CatalogFile = { version: 1, servers: {} };

export function mcpServerCatalogFingerprint(config: {
  name: string;
  type: string;
  command?: string;
  args?: string[];
  url?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: config.name,
        type: config.type,
        command: config.command ?? '',
        args: config.args ?? [],
        url: config.url ?? '',
      })
    )
    .digest('hex');
}

function catalogPath(): string | null {
  try {
    const userData = app.getPath('userData');
    if (!userData?.trim()) return null;
    return path.join(userData, 'mcp-tool-catalog.json');
  } catch (error) {
    logWarn('[McpToolCache] userData path unavailable:', error);
    return null;
  }
}

function readCatalog(): CatalogFile {
  const filePath = catalogPath();
  if (!filePath || !fs.existsSync(filePath)) return EMPTY_CATALOG;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CatalogFile;
    if (!parsed || parsed.version !== 1 || !parsed.servers || typeof parsed.servers !== 'object') {
      return EMPTY_CATALOG;
    }
    return parsed;
  } catch (error) {
    logWarn('[McpToolCache] Ignoring unreadable catalog cache:', error);
    return EMPTY_CATALOG;
  }
}

function writeCatalog(catalog: CatalogFile): void {
  const filePath = catalogPath();
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(catalog));
    fs.renameSync(tmp, filePath);
  } catch (error) {
    logWarn('[McpToolCache] Failed to write catalog cache:', error);
  }
}

class McpToolCatalogCache {
  load(serverId: string): { fingerprint: string; tools: CachedMcpTool[] } | null {
    const entry = readCatalog().servers[serverId];
    if (!entry || !Array.isArray(entry.tools) || entry.tools.length === 0) return null;
    if (typeof entry.fingerprint !== 'string' || entry.fingerprint.length === 0) return null;
    return { fingerprint: entry.fingerprint, tools: entry.tools };
  }

  save(serverId: string, fingerprint: string, tools: CachedMcpTool[]): void {
    if (!serverId || tools.length === 0) return;
    const catalog = readCatalog();
    catalog.servers[serverId] = { fingerprint, tools, savedAt: Date.now() };
    writeCatalog(catalog);
  }

  clear(serverId: string): void {
    const catalog = readCatalog();
    if (!catalog.servers[serverId]) return;
    delete catalog.servers[serverId];
    writeCatalog(catalog);
  }
}

export const mcpToolCatalogCache = new McpToolCatalogCache();
