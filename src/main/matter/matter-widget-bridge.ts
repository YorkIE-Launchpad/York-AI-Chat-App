import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { buildMatterWidgetPayload, type MatterWidgetPayload } from '../../shared/matter-widget';
import type { MatterSnapshot } from '../../shared/matter';
import { logWarn } from '../utils/logger';

const MATTER_WIDGET_FILENAME = 'matter-widget.json';
const APPLE_TEAM_ID = '7G87G26WW6';
const PROD_APP_GROUP = 'group.ie.york.app';
const DEV_APP_GROUP = 'group.ie.york.vecos.dev';
/** macOS 26+ requires Team-ID-prefixed groups for sandboxed WidgetKit extensions. */
const PROD_APP_GROUP_TEAM = `${APPLE_TEAM_ID}.${PROD_APP_GROUP}`;
const DEV_APP_GROUP_TEAM = `${APPLE_TEAM_ID}.${DEV_APP_GROUP}`;
const WIDGET_KIND = 'MatterWidget';
const WRITE_DEBOUNCE_MS = 1000;
const SYNC_HELPER_TIMEOUT_MS = 5_000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: MatterSnapshot | null = null;

/** Cancel pending widget writes/reloads during app shutdown. */
export function shutdownMatterWidgetBridge(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingSnapshot = null;
}

export function matterWidgetAppGroupId(): string {
  return app.isPackaged ? PROD_APP_GROUP_TEAM : DEV_APP_GROUP_TEAM;
}

/** Prefer Team-ID-prefixed container; also mirror legacy path for older macOS. */
export function matterWidgetGroupIds(): string[] {
  if (app.isPackaged) {
    return [PROD_APP_GROUP_TEAM, PROD_APP_GROUP];
  }
  return [DEV_APP_GROUP_TEAM, DEV_APP_GROUP];
}

export function matterWidgetJsonPath(): string {
  const group = matterWidgetAppGroupId();
  return path.join(os.homedir(), 'Library', 'Group Containers', group, MATTER_WIDGET_FILENAME);
}

function groupContainerJsonPath(group: string): string {
  return path.join(os.homedir(), 'Library', 'Group Containers', group, MATTER_WIDGET_FILENAME);
}

function resolveToolBinCandidates(binName: string): string[] {
  if (process.platform !== 'darwin') return [];
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates: string[] = [];
  try {
    if (app.isPackaged) {
      const toolsRoot = path.join(process.resourcesPath || '', 'tools');
      candidates.push(path.join(toolsRoot, 'bin', binName));
      candidates.push(path.join(toolsRoot, `darwin-${arch}`, 'bin', binName));
    }
  } catch {
    // app may be unavailable in tests
  }
  for (const root of [
    path.join(__dirname, '../../../resources/tools'),
    path.join(process.cwd(), 'resources/tools'),
  ]) {
    candidates.push(path.join(root, `darwin-${arch}`, 'bin', binName));
  }
  return candidates;
}

function resolveToolBin(binName: string): string | null {
  for (const candidate of resolveToolBinCandidates(binName)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function resolveSyncHelperPath(): string | null {
  return resolveToolBin('matter-widget-sync');
}

function resolveReloadHelperPath(): string | null {
  return resolveToolBin('matter-widget-reload');
}

/**
 * Write via sandboxed helper (FileManager App Group APIs).
 * Direct Node fs open() on Group Containers returns EPERM on modern macOS.
 */
function writeViaSyncHelper(payload: MatterWidgetPayload): boolean {
  const helper = resolveSyncHelperPath();
  if (!helper) return false;
  const body = JSON.stringify(payload);
  try {
    const result = spawnSync(helper, [WIDGET_KIND], {
      input: body,
      encoding: 'utf8',
      timeout: SYNC_HELPER_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error) {
      logWarn('[MatterWidget] sync helper spawn failed:', result.error);
      return false;
    }
    if (result.status !== 0) {
      logWarn(
        '[MatterWidget] sync helper exited',
        result.status,
        (result.stderr || '').trim() || result.stdout
      );
      return false;
    }
    return true;
  } catch (error) {
    logWarn('[MatterWidget] sync helper failed:', error);
    return false;
  }
}

/** Best-effort direct write (works in some older/dev setups; EPERM on macOS 26+). */
function writePayloadDirect(payload: MatterWidgetPayload): void {
  const body = JSON.stringify(payload);
  let wrote = 0;
  const errors: string[] = [];
  for (const group of matterWidgetGroupIds()) {
    const target = groupContainerJsonPath(group);
    try {
      const dir = path.dirname(target);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, target);
      wrote += 1;
    } catch (error) {
      errors.push(`${group}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (wrote === 0) {
    throw new Error(
      `Unable to write matter-widget.json to any App Group container (${errors.join('; ') || 'no groups'})`
    );
  }
  if (errors.length > 0) {
    logWarn('[MatterWidget] Partial widget write:', errors.join('; '));
  }
}

function writePayloadAtomic(payload: MatterWidgetPayload): void {
  if (process.platform !== 'darwin') return;
  if (writeViaSyncHelper(payload)) {
    return;
  }
  writePayloadDirect(payload);
  reloadMatterWidgetTimelines();
}

export function reloadMatterWidgetTimelines(): void {
  if (process.platform !== 'darwin') return;
  // Sync helper already reloads when it writes; this is a fallback-only path.
  const helper = resolveReloadHelperPath();
  if (!helper) return;
  try {
    const child = spawn(helper, [WIDGET_KIND], { stdio: 'ignore', detached: true });
    child.unref();
  } catch (error) {
    logWarn('[MatterWidget] Failed to reload timelines:', error);
  }
}

function flushWidgetWrite(): void {
  debounceTimer = null;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  if (!snapshot) return;
  try {
    writePayloadAtomic(buildMatterWidgetPayload(snapshot));
  } catch (error) {
    logWarn('[MatterWidget] Failed to write payload:', error);
  }
}

/** Publish Matter state for the macOS widget extension (debounced unless immediate). */
export function publishMatterWidgetSnapshot(
  snapshot: MatterSnapshot,
  options?: { immediate?: boolean }
): void {
  if (process.platform !== 'darwin') return;
  pendingSnapshot = snapshot;
  if (debounceTimer) clearTimeout(debounceTimer);
  if (options?.immediate) {
    flushWidgetWrite();
    return;
  }
  debounceTimer = setTimeout(flushWidgetWrite, WRITE_DEBOUNCE_MS);
}
