/**
 * Frontmost-app helpers for Screen Snap "Write into field" (macOS, osascript).
 * Values are passed through osascript argv, never interpolated into script text.
 */
import { execFile } from 'child_process';
import type { ScreenSnapTarget } from '../../shared/screen-snap';

const OSASCRIPT_PATH = '/usr/bin/osascript';
const ACTIVATE_TIMEOUT_MS = 1000;
const ACTIVATE_POLL_MS = 60;

export type RunOsascript = (args: string[]) => Promise<string>;

export const defaultRunOsascript: RunOsascript = (args) =>
  new Promise((resolve, reject) => {
    execFile(OSASCRIPT_PATH, args, { timeout: 4000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    );
  });

/** Tab-separated: bundleId, name, pid[, x, y, width, height]. Window bounds need Accessibility. */
const FRONTMOST_SCRIPT = [
  'tell application "System Events"',
  '  set p to first application process whose frontmost is true',
  '  set bid to bundle identifier of p',
  '  set pname to name of p',
  '  set ppid to unix id of p',
  '  try',
  '    set w to window 1 of p',
  '    set {x, y} to position of w',
  '    set {wd, ht} to size of w',
  '    return bid & tab & pname & tab & ppid & tab & x & tab & y & tab & wd & tab & ht',
  '  on error',
  '    return bid & tab & pname & tab & ppid',
  '  end try',
  'end tell',
];

const FRONTMOST_BUNDLE_SCRIPT = [
  'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
];

const ACTIVATE_SCRIPT = [
  'on run argv',
  '  tell application id (item 1 of argv) to activate',
  'end run',
];

function toOsascriptArgs(lines: string[], argv: string[] = []): string[] {
  return [...lines.flatMap((line) => ['-e', line]), ...argv];
}

/**
 * Parse FRONTMOST_SCRIPT output. Returns null when GrowthOS itself is frontmost
 * (nothing to write into) or the output is unusable.
 */
export function parseFrontmostOutput(stdout: string, selfPid: number): ScreenSnapTarget | null {
  const parts = stdout.trim().split('\t');
  if (parts.length < 3) return null;
  const [bundleId, name, pidRaw, ...rest] = parts;
  const pid = Number(pidRaw);
  if (!bundleId || bundleId === 'missing value' || !Number.isFinite(pid)) return null;
  if (pid === selfPid) return null;

  const target: ScreenSnapTarget = { bundleId, name: name || bundleId, pid };
  if (rest.length === 4) {
    const [x, y, width, height] = rest.map(Number);
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
      target.bounds = { x, y, width, height };
    }
  }
  return target;
}

/** Must run before any GrowthOS window takes focus. */
export async function getFrontmostTarget(
  run: RunOsascript = defaultRunOsascript,
  selfPid: number = process.pid
): Promise<ScreenSnapTarget | null> {
  try {
    return parseFrontmostOutput(await run(toOsascriptArgs(FRONTMOST_SCRIPT)), selfPid);
  } catch {
    return null;
  }
}

/** Re-activate the target app and wait until it is frontmost (so Cmd+V lands there). */
export async function activateTarget(
  bundleId: string,
  run: RunOsascript = defaultRunOsascript,
  timeoutMs: number = ACTIVATE_TIMEOUT_MS
): Promise<boolean> {
  try {
    await run(toOsascriptArgs(ACTIVATE_SCRIPT, [bundleId]));
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const front = (await run(toOsascriptArgs(FRONTMOST_BUNDLE_SCRIPT))).trim();
      if (front === bundleId) return true;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, ACTIVATE_POLL_MS));
  }
  return false;
}
