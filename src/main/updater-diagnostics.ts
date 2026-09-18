import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import {
  UPDATE_FEED_URL,
  getUpdaterInternalDiagnostics,
  getUpdaterStatus,
} from './updater';

/** electron-builder `appId` — ShipIt cache folder name on macOS. */
export const MACOS_UPDATE_APP_ID = 'ie.york.app';

const SHIPIT_STDOUT = 'ShipIt_stdout.log';
const SHIPIT_STDERR = 'ShipIt_stderr.log';

export function getShipItLogDirectory(appId: string = MACOS_UPDATE_APP_ID): string {
  return path.join(os.homedir(), 'Library', 'Caches', `${appId}.ShipIt`);
}

function readLogTail(filePath: string, maxBytes: number): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(filePath, 'r');
    try {
      const readLen = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function readShipItLogTails(opts?: {
  appId?: string;
  maxBytes?: number;
}): {
  directory: string;
  exists: boolean;
  stdout: string | null;
  stderr: string | null;
} {
  const directory = getShipItLogDirectory(opts?.appId);
  const maxBytes = opts?.maxBytes ?? 96_000;
  let exists = false;
  try {
    exists = fs.statSync(directory).isDirectory();
  } catch {
    exists = false;
  }
  return {
    directory,
    exists,
    stdout: readLogTail(path.join(directory, SHIPIT_STDOUT), maxBytes),
    stderr: readLogTail(path.join(directory, SHIPIT_STDERR), maxBytes),
  };
}

export function buildUpdaterDiagnosticsSnapshot(): Record<string, unknown> {
  let packaged = false;
  let version = 'unknown';
  try {
    packaged = app.isPackaged;
    version = app.getVersion();
  } catch {
    // ignore
  }
  return {
    capturedAt: new Date().toISOString(),
    app: { version, isPackaged: packaged, platform: process.platform },
    feedUrl: UPDATE_FEED_URL,
    status: getUpdaterStatus(),
    internal: getUpdaterInternalDiagnostics(),
    shipIt: readShipItLogTails(),
  };
}
