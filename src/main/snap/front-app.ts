/**
 * Frontmost-app helpers for Screen Snap "Write into field" (macOS, osascript).
 * Values are passed through osascript argv, never interpolated into script text.
 */
import { execFile } from 'child_process';
import type { ScreenSnapTarget } from '../../shared/screen-snap';
import { log, logWarn } from '../utils/logger';

const OSASCRIPT_PATH = '/usr/bin/osascript';
const ACTIVATE_TIMEOUT_MS = 1500;
const ACTIVATE_POLL_MS = 60;
/** Browsers restore DOM focus a beat after their window becomes key. */
const FOCUS_SETTLE_MS = 180;

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

/**
 * "focused" once the app is frontmost and has a focused window (key window),
 * "front" when frontmost without one yet, "back" otherwise. Web content only
 * restores focus to the previously focused input after its window is key.
 */
const FOCUS_STATE_SCRIPT = [
  'on run argv',
  '  tell application "System Events"',
  '    set p to first application process whose frontmost is true',
  '    if bundle identifier of p is not (item 1 of argv) then return "back"',
  '    try',
  '      set w to value of attribute "AXFocusedWindow" of p',
  '      if w is not missing value then return "focused"',
  '    end try',
  '    return "front"',
  '  end tell',
  'end run',
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-activate the target app and wait until its window is key and has had a
 * moment to restore focus to the previously focused field (so Cmd+V lands there).
 */
export async function activateTarget(
  bundleId: string,
  run: RunOsascript = defaultRunOsascript,
  timeoutMs: number = ACTIVATE_TIMEOUT_MS,
  settleMs: number = FOCUS_SETTLE_MS
): Promise<boolean> {
  try {
    await run(toOsascriptArgs(ACTIVATE_SCRIPT, [bundleId]));
  } catch (error) {
    logWarn('[ScreenSnap] Activate failed', bundleId, error);
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  let sawFront = false;
  while (Date.now() < deadline) {
    let state: string;
    try {
      state = (await run(toOsascriptArgs(FOCUS_STATE_SCRIPT, [bundleId]))).trim();
    } catch (error) {
      logWarn('[ScreenSnap] Focus check failed', bundleId, error);
      return false;
    }
    if (state === 'focused') {
      await sleep(settleMs);
      return true;
    }
    if (state === 'front') sawFront = true;
    await sleep(ACTIVATE_POLL_MS);
  }
  if (sawFront) {
    log('[ScreenSnap] Target frontmost without a focused window; pasting anyway', bundleId);
    await sleep(settleMs);
    return true;
  }
  logWarn('[ScreenSnap] Target never became frontmost', bundleId);
  return false;
}
