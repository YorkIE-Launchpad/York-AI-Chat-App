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
const MIN_CAPTURE_WINDOW = { width: 320, height: 240 };

export type RunOsascript = (args: string[]) => Promise<string>;

export const defaultRunOsascript: RunOsascript = (args) =>
  new Promise((resolve, reject) => {
    execFile(OSASCRIPT_PATH, args, { timeout: 4000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    );
  });

/** AppleScript handler: true when an AX element is a text input (incl. contenteditable in browsers). */
const IS_EDITABLE_HANDLER = [
  'on isEditable(e)',
  '  tell application "System Events"',
  '    try',
  '      set r to value of attribute "AXRole" of e',
  '      if {"AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"} contains r then return true',
  '    end try',
  '    try',
  '      if (value of attribute "AXEditableAncestor" of e) is not missing value then return true',
  '    end try',
  '  end tell',
  '  return false',
  'end isEditable',
];

/**
 * Tab-separated: bundleId, name, pid, then window x/y/w/h and focused text
 * field x/y/w/h (empty when unknown). Both frames need Accessibility.
 * AXManualAccessibility asks Chromium-based apps to expose web content to AX.
 */
const FRONTMOST_SCRIPT = [
  ...IS_EDITABLE_HANDLER,
  'on isCapturable(w)',
  '  tell application "System Events"',
  '    try',
  '      if w is missing value then return false',
  '      if (value of attribute "AXSubrole" of w) is not "AXStandardWindow" then return false',
  '      try',
  '        if (value of attribute "AXMinimized" of w) is true then return false',
  '      end try',
  '      return true',
  '    end try',
  '  end tell',
  '  return false',
  'end isCapturable',
  'tell application "System Events"',
  '  set p to first application process whose frontmost is true',
  '  set bid to bundle identifier of p',
  '  set pname to name of p',
  '  set ppid to unix id of p',
  '  set winPart to tab & tab & tab',
  '  try',
  // Only a real document window is auto-captured; toolbar strips, popovers, sheets
  // and panels are skipped (no bounds => the user selects a region instead).
  '    set w to missing value',
  '    try',
  '      set cand to value of attribute "AXFocusedWindow" of p',
  '      if my isCapturable(cand) then set w to cand',
  '    end try',
  '    if w is missing value then',
  '      try',
  '        set cand to value of attribute "AXMainWindow" of p',
  '        if my isCapturable(cand) then set w to cand',
  '      end try',
  '    end if',
  '    if w is missing value then',
  '      repeat with cand in (windows of p)',
  '        if my isCapturable(cand) then',
  '          set w to contents of cand',
  '          exit repeat',
  '        end if',
  '      end repeat',
  '    end if',
  '    if w is missing value then error "no capturable window"',
  '    set {x, y} to value of attribute "AXPosition" of w',
  '    set {wd, ht} to value of attribute "AXSize" of w',
  '    set winPart to ((x as integer) as text) & tab & (y as integer) & tab & (wd as integer) & tab & (ht as integer)',
  '  end try',
  '  set fieldPart to tab & tab & tab',
  '  try',
  '    set value of attribute "AXManualAccessibility" of p to true',
  '  end try',
  '  repeat 3 times',
  '    try',
  '      set e to value of attribute "AXFocusedUIElement" of p',
  '      if my isEditable(e) then',
  '        set {fx, fy} to value of attribute "AXPosition" of e',
  '        set {fw, fh} to value of attribute "AXSize" of e',
  '        set fieldPart to ((fx as integer) as text) & tab & (fy as integer) & tab & (fw as integer) & tab & (fh as integer)',
  '        exit repeat',
  '      end if',
  '    end try',
  '    delay 0.1',
  '  end repeat',
  '  return bid & tab & pname & tab & ppid & tab & winPart & tab & fieldPart',
  'end tell',
];

/** "editable" when the frontmost app's focused element is a text input, "other" when not, "unknown" without AX. */
const FOCUSED_FIELD_SCRIPT = [
  ...IS_EDITABLE_HANDLER,
  'tell application "System Events"',
  '  set p to first application process whose frontmost is true',
  '  try',
  '    set e to value of attribute "AXFocusedUIElement" of p',
  '  on error',
  '    return "unknown"',
  '  end try',
  '  if e is missing value then return "other"',
  '  if my isEditable(e) then return "editable"',
  '  return "other"',
  'end tell',
];

const CLICK_SCRIPT = [
  'on run argv',
  '  tell application "System Events" to click at {(item 1 of argv) as integer, (item 2 of argv) as integer}',
  'end run',
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
  const bounds = parseFrame(rest.slice(0, 4));
  // A toolbar/strip-sized "window" is not worth capturing; region selection is used instead.
  if (
    bounds &&
    bounds.width >= MIN_CAPTURE_WINDOW.width &&
    bounds.height >= MIN_CAPTURE_WINDOW.height
  ) {
    target.bounds = bounds;
  }
  const focusedField = parseFrame(rest.slice(4, 8));
  if (focusedField) target.focusedField = focusedField;
  return target;
}

function parseFrame(parts: string[]): ScreenSnapTarget['bounds'] | null {
  if (parts.length !== 4 || parts.some((part) => part.trim() === '')) return null;
  const [x, y, width, height] = parts.map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
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

export type FocusedFieldState = 'editable' | 'other' | 'unknown';

async function focusedFieldState(run: RunOsascript): Promise<FocusedFieldState> {
  try {
    const state = (await run(toOsascriptArgs(FOCUSED_FIELD_SCRIPT))).trim();
    return state === 'editable' || state === 'other' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function waitForEditable(run: RunOsascript, timeoutMs: number): Promise<FocusedFieldState> {
  const deadline = Date.now() + timeoutMs;
  let state = await focusedFieldState(run);
  while (state === 'other' && Date.now() < deadline) {
    await sleep(ACTIVATE_POLL_MS);
    state = await focusedFieldState(run);
  }
  return state;
}

const FIELD_RESTORE_WAIT_MS = 300;
const FIELD_AFTER_CLICK_WAIT_MS = 900;

/**
 * Make sure a text field has keyboard focus in the (already frontmost) target
 * before pasting. Web apps often close inline editors on blur (when the snap
 * panel took focus); clicking where the field was reopens/refocuses it.
 * Returns false only when AX positively reports no text field afterwards.
 */
export async function ensureFieldFocused(
  field: NonNullable<ScreenSnapTarget['focusedField']>,
  run: RunOsascript = defaultRunOsascript,
  timeouts: { restoreMs?: number; afterClickMs?: number } = {}
): Promise<boolean> {
  const before = await waitForEditable(run, timeouts.restoreMs ?? FIELD_RESTORE_WAIT_MS);
  if (before !== 'other') return true;

  const x = Math.round(field.x + field.width / 2);
  const y = Math.round(field.y + Math.min(field.height / 2, 20));
  logWarn('[ScreenSnap] Focused field was lost; clicking to restore it at', x, y);
  try {
    await run(toOsascriptArgs(CLICK_SCRIPT, [String(x), String(y)]));
  } catch (error) {
    logWarn('[ScreenSnap] Restore click failed', error);
    return false;
  }
  const after = await waitForEditable(run, timeouts.afterClickMs ?? FIELD_AFTER_CLICK_WAIT_MS);
  if (after === 'other') logWarn('[ScreenSnap] No text field focused after restore click');
  return after !== 'other';
}
