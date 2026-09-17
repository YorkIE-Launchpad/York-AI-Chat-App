import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { buildMatterWidgetPayload, type MatterWidgetPayload } from '../../shared/matter-widget';
import type { MatterSnapshot } from '../../shared/matter';
import { logWarn } from '../utils/logger';

const MATTER_WIDGET_FILENAME = 'matter-widget.json';
const PROD_APP_GROUP = 'group.ie.york.app';
const DEV_APP_GROUP = 'group.ie.york.vecos.dev';
const WIDGET_KIND = 'MatterWidget';
const WRITE_DEBOUNCE_MS = 1000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: MatterSnapshot | null = null;

export function matterWidgetAppGroupId(): string {
  return app.isPackaged ? PROD_APP_GROUP : DEV_APP_GROUP;
}

export function matterWidgetJsonPath(): string {
  const group = matterWidgetAppGroupId();
  return path.join(os.homedir(), 'Library', 'Group Containers', group, MATTER_WIDGET_FILENAME);
}

function resolveReloadHelperPath(): string | null {
  if (process.platform !== 'darwin') return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const binName = 'matter-widget-reload';
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
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function writePayloadAtomic(payload: MatterWidgetPayload): void {
  if (process.platform !== 'darwin') return;
  const target = matterWidgetJsonPath();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, target);
}

export function reloadMatterWidgetTimelines(): void {
  if (process.platform !== 'darwin') return;
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
    const payload = buildMatterWidgetPayload(snapshot);
    writePayloadAtomic(payload);
    reloadMatterWidgetTimelines();
  } catch (error) {
    logWarn('[MatterWidget] Failed to write payload:', error);
  }
}

/** Debounced publish of Matter state for the macOS widget extension. */
export function publishMatterWidgetSnapshot(snapshot: MatterSnapshot): void {
  if (process.platform !== 'darwin') return;
  pendingSnapshot = snapshot;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushWidgetWrite, WRITE_DEBOUNCE_MS);
}
