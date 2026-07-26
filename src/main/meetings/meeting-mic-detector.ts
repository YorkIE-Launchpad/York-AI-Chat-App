import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

export interface MicProbeProcess {
  pid: number;
  bundleId?: string | null;
  name?: string | null;
  path?: string | null;
}

export interface MicProbeResult {
  active: boolean;
  mode: string;
  processes: MicProbeProcess[];
  deviceRunningSomewhere: boolean;
}

export interface ZoomMicUsage {
  /** Zoom (or a Zoom helper) currently has an active CoreAudio input stream. */
  zoomUsingMic: boolean;
  /** Probe binary ran successfully. */
  probeAvailable: boolean;
  /** Raw probe mode: process | device | unavailable */
  mode: string;
  /** Mic-active processes after excluding our own PIDs. */
  processes: MicProbeProcess[];
}

const ZOOM_BUNDLE_IDS = new Set(['us.zoom.xos', 'zoom.us.ZoomOpus', 'us.zoom.ZoomPresence']);

const ZOOM_NAME_PATTERN = /^(zoom\.us|zoom|zoom workplace|cpthost)$/i;
const ZOOM_PATH_PATTERN = /(Zoom\.app\/|zoom\.us\.app\/)/i;

/** Exported for unit tests. */
export function isZoomMicProcess(proc: MicProbeProcess): boolean {
  const bundleId = (proc.bundleId || '').trim();
  if (bundleId && (ZOOM_BUNDLE_IDS.has(bundleId) || bundleId.startsWith('us.zoom.'))) {
    return true;
  }
  const name = (proc.name || '').trim();
  if (name && ZOOM_NAME_PATTERN.test(name)) {
    return true;
  }
  const procPath = (proc.path || '').trim();
  if (procPath && ZOOM_PATH_PATTERN.test(procPath)) {
    return true;
  }
  return false;
}

/** Exported for unit tests. */
export function parseMicProbeJson(raw: string): MicProbeResult {
  const parsed = JSON.parse(raw) as Partial<MicProbeResult>;
  const processes = Array.isArray(parsed.processes)
    ? parsed.processes.map((p) => ({
        pid: Number((p as MicProbeProcess).pid) || 0,
        bundleId: (p as MicProbeProcess).bundleId ?? null,
        name: (p as MicProbeProcess).name ?? null,
        path: (p as MicProbeProcess).path ?? null,
      }))
    : [];
  return {
    active: Boolean(parsed.active),
    mode: typeof parsed.mode === 'string' ? parsed.mode : 'unknown',
    processes,
    deviceRunningSomewhere: Boolean(parsed.deviceRunningSomewhere),
  };
}

function collectSelfPids(): Set<number> {
  const pids = new Set<number>([process.pid]);
  if (typeof process.ppid === 'number' && process.ppid > 0) {
    pids.add(process.ppid);
  }
  return pids;
}

/** Exported for unit tests. */
export function filterZoomMicUsage(
  probe: MicProbeResult,
  selfPids: Set<number> = collectSelfPids()
): ZoomMicUsage {
  const processes = probe.processes.filter((p) => p.pid > 0 && !selfPids.has(p.pid));
  const zoomUsingMic = processes.some(isZoomMicProcess);
  return {
    zoomUsingMic,
    probeAvailable: true,
    mode: probe.mode,
    processes,
  };
}

function resolveMeetingMicProbePath(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates: string[] = [];

  try {
    if (app?.isPackaged) {
      candidates.push(
        path.join(process.resourcesPath || '', 'tools', 'bin', 'meeting-mic-probe'),
        path.join(
          process.resourcesPath || '',
          'tools',
          `darwin-${arch}`,
          'bin',
          'meeting-mic-probe'
        ),
        path.join(process.resourcesPath || '', 'tools', 'meeting-mic-probe')
      );
    }
  } catch {
    // app may be unavailable in unit tests
  }

  // Dev / unpackaged (and unit-test friendly relative to cwd).
  const projectRootGuesses = [
    path.join(__dirname, '../../../resources/tools'),
    path.join(process.cwd(), 'resources/tools'),
  ];
  for (const root of projectRootGuesses) {
    candidates.push(
      path.join(root, `darwin-${arch}`, 'bin', 'meeting-mic-probe'),
      path.join(root, 'bin', 'meeting-mic-probe')
    );
  }

  // Built from source tree without staging.
  candidates.push(
    path.join(__dirname, '../../../native/macos-mic-probe/meeting-mic-probe'),
    path.join(process.cwd(), 'native/macos-mic-probe/meeting-mic-probe')
  );

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

async function runMicProbe(): Promise<MicProbeResult | null> {
  if (process.platform !== 'darwin') {
    return null;
  }
  const probePath = resolveMeetingMicProbePath();
  if (!probePath) {
    return null;
  }
  try {
    const result = await execFileAsync(probePath, [], {
      timeout: 1500,
      maxBuffer: 256_000,
    });
    return parseMicProbeJson(result.stdout.trim() || '{}');
  } catch {
    return null;
  }
}

/**
 * Granola-style signal: is Zoom actively using the microphone?
 * Windows/Linux: unsupported (returns probeAvailable false).
 */
export async function detectZoomMicUsage(): Promise<ZoomMicUsage> {
  const probe = await runMicProbe();
  if (!probe) {
    return {
      zoomUsingMic: false,
      probeAvailable: false,
      mode: 'unavailable',
      processes: [],
    };
  }
  return filterZoomMicUsage(probe);
}

/** Overview banner helper — Zoom only when it holds the mic. */
export async function detectMeetingApps(): Promise<string[]> {
  const usage = await detectZoomMicUsage();
  return usage.zoomUsingMic ? ['Zoom'] : [];
}
