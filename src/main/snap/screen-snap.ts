/**
 * Screen Snap (macOS): global shortcut -> capture -> floating composer window.
 * - "chat" mode: native region selector, then a new GrowthOS chat with the image.
 * - "write" mode: front-window capture, quick vision answer, then paste the
 *   text into the field that was focused in the original app.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  BrowserWindow,
  clipboard,
  globalShortcut as electronGlobalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  type WebContents,
} from 'electron';
import { log, logError, logWarn } from '../utils/logger';
import {
  DEFAULT_SCREEN_SNAP_SHORTCUT,
  validateScreenSnapAccelerator,
  type ScreenSnapComposerState,
  type ScreenSnapGenerateRequest,
  type ScreenSnapGenerateResult,
  type ScreenSnapImage,
  type ScreenSnapInsertResult,
  type ScreenSnapMode,
  type ScreenSnapShortcutResult,
  type ScreenSnapSubmitPayload,
  type ScreenSnapTarget,
} from '../../shared/screen-snap';
import {
  activateTarget as defaultActivateTarget,
  getFrontmostTarget as defaultGetFrontmostTarget,
} from './front-app';
import { pasteText as defaultPasteText, type PasteResult } from './paste-into-app';

/** Claude rejects base64 images over 5MB; base64 adds ~33%. */
export const MAX_SNAP_IMAGE_BYTES = 3.75 * 1024 * 1024;
export const SNAP_DOWNSCALE_MAX_EDGE = 2048;
const SNAP_JPEG_QUALITY = 85;
const SCREENCAPTURE_PATH = '/usr/sbin/screencapture';
const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

export const SNAP_WRITE_SYSTEM_PROMPT =
  'You write text that will be inserted directly into a text field the user is typing in. ' +
  'Use the screenshot as context and follow the instruction. ' +
  'Output only the text to insert: no preamble, no explanations, no surrounding quotes, ' +
  'and no markdown unless the instruction asks for it.';

const COMPOSER_WIDTH = 560;
const COMPOSER_HEIGHT: Record<ScreenSnapMode, number> = { chat: 500, write: 660 };

export type ExecFileFn = (file: string, args: string[]) => Promise<void>;

const defaultExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error) => (error ? reject(error) : resolve()));
  });

/**
 * Encode a captured PNG for the model. Oversized captures (e.g. full 5K
 * retina screens) are downscaled to a max edge and re-encoded as JPEG.
 */
export function encodeSnapImage(png: Buffer): ScreenSnapImage | null {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return null;
  const size = image.getSize();

  if (png.length <= MAX_SNAP_IMAGE_BYTES) {
    return {
      base64: png.toString('base64'),
      mediaType: 'image/png',
      width: size.width,
      height: size.height,
    };
  }

  const longest = Math.max(size.width, size.height);
  const resized =
    longest > SNAP_DOWNSCALE_MAX_EDGE
      ? image.resize(
          size.width >= size.height
            ? { width: SNAP_DOWNSCALE_MAX_EDGE, quality: 'best' }
            : { height: SNAP_DOWNSCALE_MAX_EDGE, quality: 'best' }
        )
      : image;
  const jpeg = resized.toJPEG(SNAP_JPEG_QUALITY);
  const resizedSize = resized.getSize();
  return {
    base64: jpeg.toString('base64'),
    mediaType: 'image/jpeg',
    width: resizedSize.width,
    height: resizedSize.height,
  };
}

async function runScreencapture(
  args: string[],
  execFileFn: ExecFileFn
): Promise<ScreenSnapImage | null> {
  const tmpPath = join(os.tmpdir(), `growthos-snap-${Date.now()}.png`);
  try {
    try {
      await execFileFn(SCREENCAPTURE_PATH, [...args, tmpPath]);
    } catch (error) {
      // screencapture exits non-zero on cancel in some macOS versions.
      if (!fs.existsSync(tmpPath)) return null;
      logWarn('[ScreenSnap] screencapture exited with error but produced a file', error);
    }
    if (!fs.existsSync(tmpPath)) return null;
    const png = fs.readFileSync(tmpPath);
    if (png.length === 0) return null;
    return encodeSnapImage(png);
  } finally {
    fs.rm(tmpPath, { force: true }, () => undefined);
  }
}

/**
 * Run the native interactive region selector. Resolves `null` when the user
 * cancels (Esc), since screencapture then writes no file.
 */
export function captureRegion(
  execFileFn: ExecFileFn = defaultExecFile
): Promise<ScreenSnapImage | null> {
  return runScreencapture(['-i', '-x'], execFileFn);
}

/** Capture a fixed rectangle (global screen points), e.g. the front window. */
export function captureRect(
  bounds: NonNullable<ScreenSnapTarget['bounds']>,
  execFileFn: ExecFileFn = defaultExecFile
): Promise<ScreenSnapImage | null> {
  const rect = [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(',');
  return runScreencapture(['-x', '-R', rect], execFileFn);
}

export interface GlobalShortcutLike {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
}

export type SnapGenerateFn = (
  request: ScreenSnapGenerateRequest,
  onDelta: (text: string) => void,
  signal: AbortSignal
) => Promise<string>;

export interface ScreenSnapControllerOptions {
  /** Persist the new shortcut (null = disabled). */
  persistShortcut: (shortcut: string | null) => void;
  /** Called after the active shortcut changes so menus can relabel. */
  onShortcutChanged?: (shortcut: string | null) => void;
  /**
   * Called after a snap is queued: focus the main window and tell its renderer
   * to pull it via `snap.takePendingSubmit` (queued so a cold-starting window
   * does not miss it).
   */
  onSubmitQueued?: () => void;
  /** Loads the renderer (dev URL or dist) into the composer window with `#snap`. */
  loadComposer?: (win: BrowserWindow) => Promise<void>;
  preloadPath?: string;
  platform?: NodeJS.Platform;
  globalShortcut?: GlobalShortcutLike;
  capture?: () => Promise<ScreenSnapImage | null>;
  captureRect?: (
    bounds: NonNullable<ScreenSnapTarget['bounds']>
  ) => Promise<ScreenSnapImage | null>;
  notify?: (title: string, body: string) => void;
  getMode?: () => ScreenSnapMode;
  persistMode?: (mode: ScreenSnapMode) => void;
  /** Vision one-shot used by "write" mode. */
  generate?: SnapGenerateFn;
  getFrontmostTarget?: () => Promise<ScreenSnapTarget | null>;
  activateTarget?: (bundleId: string) => Promise<boolean>;
  pasteText?: (text: string) => Promise<PasteResult>;
  isAccessibilityTrusted?: (prompt: boolean) => boolean;
  writeClipboard?: (text: string) => void;
}

export class ScreenSnapController {
  private activeShortcut: string | null = null;
  private capturing = false;
  private composer: BrowserWindow | null = null;
  private pendingState: ScreenSnapComposerState | null = null;
  private pendingSubmit: ScreenSnapSubmitPayload | null = null;
  private target: ScreenSnapTarget | null = null;
  private generateAbort: AbortController | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly globalShortcut: GlobalShortcutLike;
  private readonly capture: () => Promise<ScreenSnapImage | null>;
  private readonly captureRectFn: NonNullable<ScreenSnapControllerOptions['captureRect']>;

  constructor(private readonly options: ScreenSnapControllerOptions) {
    this.platform = options.platform ?? process.platform;
    this.globalShortcut = options.globalShortcut ?? electronGlobalShortcut;
    this.capture = options.capture ?? (() => captureRegion());
    this.captureRectFn = options.captureRect ?? ((bounds) => captureRect(bounds));
  }

  get isSupported(): boolean {
    return this.platform === 'darwin';
  }

  getShortcut(): string | null {
    return this.activeShortcut;
  }

  getTarget(): ScreenSnapTarget | null {
    return this.target;
  }

  /** Register the configured shortcut at startup. Returns false on conflict. */
  registerShortcut(shortcut: string | null | undefined): boolean {
    if (!this.isSupported) return false;
    const next = shortcut === undefined ? DEFAULT_SCREEN_SNAP_SHORTCUT : shortcut;
    this.unregisterActive();
    if (next === null) return true;
    if (!this.tryRegister(next)) {
      log('[ScreenSnap] Failed to register shortcut', next);
      return false;
    }
    this.activeShortcut = next;
    return true;
  }

  /** Change the shortcut from Settings; rolls back to the previous one on failure. */
  setShortcut(shortcut: string | null): ScreenSnapShortcutResult {
    const previous = this.activeShortcut;
    if (!this.isSupported) {
      return { success: false, reason: 'invalid', shortcut: previous };
    }

    if (shortcut === null) {
      this.unregisterActive();
      this.options.persistShortcut(null);
      this.options.onShortcutChanged?.(null);
      return { success: true, shortcut: null };
    }

    const validation = validateScreenSnapAccelerator(shortcut);
    if (!validation.ok) {
      return { success: false, reason: validation.reason, shortcut: previous };
    }

    this.unregisterActive();
    if (!this.tryRegister(shortcut)) {
      if (previous && this.tryRegister(previous)) {
        this.activeShortcut = previous;
      }
      return { success: false, reason: 'conflict', shortcut: this.activeShortcut };
    }

    this.activeShortcut = shortcut;
    this.options.persistShortcut(shortcut);
    this.options.onShortcutChanged?.(shortcut);
    return { success: true, shortcut };
  }

  /** Start a capture (shortcut, menu, or tray). No-op while one is running. */
  async trigger(): Promise<void> {
    if (!this.isSupported || this.capturing) return;
    if (!this.ensureScreenPermission()) return;

    this.capturing = true;
    try {
      // Record the app the user is in before any GrowthOS window takes focus.
      const getFront = this.options.getFrontmostTarget ?? (() => defaultGetFrontmostTarget());
      this.target = await getFront().catch(() => null);

      const preferredMode = this.options.getMode?.() ?? 'chat';
      const bounds = this.target?.bounds;
      const image =
        preferredMode === 'write' && bounds
          ? await this.captureRectFn(bounds)
          : await this.capture();
      if (!image) {
        log('[ScreenSnap] Capture cancelled');
        return;
      }
      const mode: ScreenSnapMode = preferredMode === 'write' && this.target ? 'write' : 'chat';
      this.openComposer({ image, mode, targetAppName: this.target?.name ?? null });
    } catch (error) {
      logError('[ScreenSnap] Capture failed:', error);
    } finally {
      this.capturing = false;
    }
  }

  submit(payload: ScreenSnapSubmitPayload): boolean {
    if (!payload?.image?.base64) return false;
    this.closeComposer();
    this.pendingSubmit = {
      text: typeof payload.text === 'string' ? payload.text : '',
      image: payload.image,
    };
    this.options.onSubmitQueued?.();
    return true;
  }

  takePendingSubmit(): ScreenSnapSubmitPayload | null {
    const pending = this.pendingSubmit;
    this.pendingSubmit = null;
    return pending;
  }

  setMode(mode: ScreenSnapMode): void {
    if (mode !== 'chat' && mode !== 'write') return;
    this.options.persistMode?.(mode);
    if (this.pendingState) this.pendingState = { ...this.pendingState, mode };
    if (this.composer && !this.composer.isDestroyed()) {
      this.composer.setBounds(this.composerBounds(mode));
    }
  }

  /** Stream a vision answer for "write" mode. Cancels any generation in flight. */
  async generate(
    request: ScreenSnapGenerateRequest,
    onDelta: (text: string) => void
  ): Promise<ScreenSnapGenerateResult> {
    if (!this.options.generate) return { success: false, error: 'Generation unavailable' };
    if (!request?.image?.base64 || !request.instruction?.trim()) {
      return { success: false, error: 'Missing instruction or image' };
    }
    this.cancelGenerate();
    const abort = new AbortController();
    this.generateAbort = abort;
    try {
      const text = await this.options.generate(request, onDelta, abort.signal);
      if (abort.signal.aborted) return { success: false, error: 'Cancelled', cancelled: true };
      return { success: true, text: text.trim() };
    } catch (error) {
      if (abort.signal.aborted) return { success: false, error: 'Cancelled', cancelled: true };
      logError('[ScreenSnap] Generate failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.generateAbort === abort) this.generateAbort = null;
    }
  }

  cancelGenerate(): void {
    this.generateAbort?.abort();
    this.generateAbort = null;
  }

  /**
   * Paste `text` into the field focused in the target app. Keeps the composer
   * open (text on clipboard) when Accessibility is missing or the app is gone,
   * so the user still sees what happened.
   */
  async insert(text: string): Promise<ScreenSnapInsertResult> {
    const writeClipboard =
      this.options.writeClipboard ?? ((value: string) => clipboard.writeText(value));
    const isTrusted =
      this.options.isAccessibilityTrusted ??
      ((prompt: boolean) => systemPreferences.isTrustedAccessibilityClient(prompt));

    if (!text) return { success: false, reason: 'failed' };
    const target = this.target;
    if (!target) {
      writeClipboard(text);
      return { success: false, reason: 'no_target' };
    }
    if (!isTrusted(true)) {
      writeClipboard(text);
      return { success: false, reason: 'accessibility' };
    }

    this.composer?.hide();
    const activate =
      this.options.activateTarget ?? ((bundleId: string) => defaultActivateTarget(bundleId));
    if (!(await activate(target.bundleId))) {
      writeClipboard(text);
      this.showComposer();
      return { success: false, reason: 'target_unavailable' };
    }

    const paste = this.options.pasteText ?? ((value: string) => defaultPasteText(value));
    const result = await paste(text);
    if (!result.success) {
      this.showComposer();
      return { success: false, reason: result.reason };
    }
    this.closeComposer();
    return { success: true };
  }

  registerIpc(): void {
    ipcMain.handle('snap.getPendingState', () => this.pendingState);
    ipcMain.handle('snap.submit', (_event, payload: ScreenSnapSubmitPayload) => ({
      success: this.submit(payload),
    }));
    ipcMain.handle('snap.takePendingSubmit', () => this.takePendingSubmit());
    ipcMain.handle('snap.cancel', () => {
      this.closeComposer();
      return { success: true };
    });
    ipcMain.handle('snap.getShortcut', () => ({
      shortcut: this.activeShortcut,
      supported: this.isSupported,
    }));
    ipcMain.handle('snap.setShortcut', (_event, shortcut: string | null) =>
      this.setShortcut(typeof shortcut === 'string' ? shortcut : null)
    );
    ipcMain.handle('snap.trigger', () => {
      void this.trigger();
      return { success: true };
    });
    ipcMain.handle('snap.setMode', (_event, mode: ScreenSnapMode) => {
      this.setMode(mode);
      return { success: true };
    });
    ipcMain.handle('snap.generate', (event, request: ScreenSnapGenerateRequest) => {
      const sender: WebContents = event.sender;
      return this.generate(request, (text) => {
        if (!sender.isDestroyed()) sender.send('snap:generateDelta', text);
      });
    });
    ipcMain.handle('snap.cancelGenerate', () => {
      this.cancelGenerate();
      return { success: true };
    });
    ipcMain.handle('snap.insert', (_event, text: string) =>
      this.insert(typeof text === 'string' ? text : '')
    );
    ipcMain.handle('snap.openAccessibilitySettings', async () => {
      await shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
      return { success: true };
    });
  }

  dispose(): void {
    this.unregisterActive();
    this.closeComposer();
  }

  private tryRegister(accelerator: string): boolean {
    try {
      return this.globalShortcut.register(accelerator, () => {
        void this.trigger();
      });
    } catch (error) {
      logWarn('[ScreenSnap] Invalid accelerator', accelerator, error);
      return false;
    }
  }

  private unregisterActive(): void {
    if (!this.activeShortcut) return;
    try {
      this.globalShortcut.unregister(this.activeShortcut);
    } catch (error) {
      logWarn('[ScreenSnap] Failed to unregister', this.activeShortcut, error);
    }
    this.activeShortcut = null;
  }

  private ensureScreenPermission(): boolean {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'denied' && status !== 'restricted') return true;
    logWarn('[ScreenSnap] Screen Recording permission is', status);
    this.options.notify?.(
      'Screen Recording permission needed',
      'Allow York GrowthOS in System Settings > Privacy & Security > Screen Recording to use Screen Snap.'
    );
    void shell.openExternal(SCREEN_RECORDING_SETTINGS_URL);
    return false;
  }

  private showComposer(): void {
    if (this.composer && !this.composer.isDestroyed()) {
      this.composer.show();
      this.composer.focus();
    }
  }

  /** Centered on the display under the cursor. */
  private composerBounds(mode: ScreenSnapMode): Electron.Rectangle {
    const cursor = screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayNearestPoint(cursor);
    const height = Math.min(COMPOSER_HEIGHT[mode], workArea.height);
    return {
      x: Math.round(workArea.x + (workArea.width - COMPOSER_WIDTH) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width: COMPOSER_WIDTH,
      height,
    };
  }

  private openComposer(state: ScreenSnapComposerState): void {
    this.cancelGenerate();
    this.pendingState = state;
    const bounds = this.composerBounds(state.mode);

    if (this.composer && !this.composer.isDestroyed()) {
      this.composer.setBounds(bounds);
      this.composer.webContents.send('snap:image', state);
      this.showComposer();
      return;
    }

    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    win.webContents.on('did-finish-load', () => {
      if (this.pendingState) {
        win.webContents.send('snap:image', this.pendingState);
      }
    });
    win.on('closed', () => {
      if (this.composer === win) {
        this.composer = null;
        this.pendingState = null;
        this.cancelGenerate();
      }
    });
    this.composer = win;

    void (this.options.loadComposer?.(win) ?? Promise.resolve()).catch((error: unknown) => {
      logError('[ScreenSnap] Failed to load composer:', error);
      this.closeComposer();
    });
  }

  private closeComposer(): void {
    const win = this.composer;
    this.composer = null;
    this.pendingState = null;
    this.cancelGenerate();
    if (win && !win.isDestroyed()) {
      win.close();
    }
  }
}
