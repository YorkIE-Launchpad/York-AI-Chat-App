/**
 * Paste text into the focused field of the frontmost app via clipboard + paste
 * keystroke, then restore the user's previous clipboard (best effort).
 * macOS: Accessibility + Cmd+V. Windows: Ctrl+V via SendKeys.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { clipboard, systemPreferences, type NativeImage } from 'electron';
import { defaultRunOsascript, type RunOsascript } from './front-app';
import { logWarn } from '../utils/logger';

const execFileAsync = promisify(execFile);
const PASTE_SCRIPT = ['-e', 'tell application "System Events" to keystroke "v" using command down'];
const WINDOWS_PASTE_PS =
  "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')";
/** Long enough for slow apps (e.g. busy browser tabs) to read the clipboard on paste. */
export const CLIPBOARD_RESTORE_DELAY_MS = 1500;

export interface ClipboardLike {
  readText: () => string;
  readHTML: () => string;
  readRTF: () => string;
  readImage: () => NativeImage;
  writeText: (text: string) => void;
  write: (data: { text?: string; html?: string; rtf?: string; image?: NativeImage }) => void;
  clear: () => void;
}

export type RunWindowsPaste = () => Promise<void>;

export interface PasteDeps {
  clipboard?: ClipboardLike;
  /** Prompts for Accessibility when `prompt` is true and access is missing. */
  isTrusted?: (prompt: boolean) => boolean;
  runOsascript?: RunOsascript;
  runWindowsPaste?: RunWindowsPaste;
  platform?: NodeJS.Platform;
  schedule?: (fn: () => void, ms: number) => void;
}

export const defaultRunWindowsPaste: RunWindowsPaste = async () => {
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PASTE_PS],
    { timeout: 4000, windowsHide: true }
  );
};

export type PasteResult =
  | { success: true }
  | { success: false; reason: 'accessibility' | 'failed' };

interface ClipboardSnapshot {
  text: string;
  html: string;
  rtf: string;
  image: NativeImage | null;
}

function snapshotClipboard(cb: ClipboardLike): ClipboardSnapshot {
  const image = cb.readImage();
  return {
    text: cb.readText(),
    html: cb.readHTML(),
    rtf: cb.readRTF(),
    image: image && !image.isEmpty() ? image : null,
  };
}

function restoreClipboard(cb: ClipboardLike, snapshot: ClipboardSnapshot): void {
  const data: { text?: string; html?: string; rtf?: string; image?: NativeImage } = {};
  if (snapshot.text) data.text = snapshot.text;
  if (snapshot.html) data.html = snapshot.html;
  if (snapshot.rtf) data.rtf = snapshot.rtf;
  if (snapshot.image) data.image = snapshot.image;
  if (Object.keys(data).length === 0) {
    cb.clear();
    return;
  }
  cb.write(data);
}

/**
 * Paste `text` into whatever field has focus in the frontmost app.
 * Without Accessibility permission (macOS) the text is left on the clipboard so the
 * user can paste themselves.
 */
export async function pasteText(text: string, deps: PasteDeps = {}): Promise<PasteResult> {
  const cb = deps.clipboard ?? clipboard;
  const platform = deps.platform ?? process.platform;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));

  if (platform === 'darwin') {
    const isTrusted =
      deps.isTrusted ??
      ((prompt: boolean) => systemPreferences.isTrustedAccessibilityClient(prompt));
    if (!isTrusted(true)) {
      cb.writeText(text);
      return { success: false, reason: 'accessibility' };
    }
  }

  const snapshot = snapshotClipboard(cb);
  cb.writeText(text);
  try {
    if (platform === 'win32') {
      const runWin = deps.runWindowsPaste ?? defaultRunWindowsPaste;
      await runWin();
    } else if (platform === 'darwin') {
      const run = deps.runOsascript ?? defaultRunOsascript;
      await run(PASTE_SCRIPT);
    } else {
      return { success: false, reason: 'failed' };
    }
  } catch (error) {
    logWarn('[Paste] Paste keystroke failed; text left on clipboard', error);
    return { success: false, reason: 'failed' };
  }

  schedule(() => {
    // Leave the clipboard alone if the user copied something else meanwhile.
    if (cb.readText() !== text) return;
    try {
      restoreClipboard(cb, snapshot);
    } catch (error) {
      logWarn('[Paste] Clipboard restore failed', error);
    }
  }, CLIPBOARD_RESTORE_DELAY_MS);

  return { success: true };
}
