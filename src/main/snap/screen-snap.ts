/**
 * Screen Snap (macOS): global shortcut -> capture -> floating composer window.
 * - "chat" mode: native region selector, then an in-place chat in the panel,
 *   backed by a real GrowthOS session (so the chat is also saved in GrowthOS).
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
  SNAP_FORWARDED_EVENT_TYPES,
  validateScreenSnapAccelerator,
  type ScreenSnapChatResult,
  type ScreenSnapStartChatOptions,
  type ScreenSnapComposerState,
  type ScreenSnapLayout,
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
  ensureFieldFocused as defaultEnsureFieldFocused,
  getFrontmostTarget as defaultGetFrontmostTarget,
} from './front-app';
import { pasteText as defaultPasteText, type PasteResult } from './paste-into-app';
import { ScreenRecordingPermission } from './screen-permission';

/** Claude rejects base64 images over 5MB; base64 adds ~33%. */
export const MAX_SNAP_IMAGE_BYTES = 3.75 * 1024 * 1024;
export const SNAP_DOWNSCALE_MAX_EDGE = 2048;
const SNAP_JPEG_QUALITY = 85;
const SCREENCAPTURE_PATH = '/usr/sbin/screencapture';
const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

export const SNAP_WRITE_SYSTEM_PROMPT =
  'You write text that will be inserted directly into a text field the user is typing in. ' +
  'Use the screenshot as context and follow the instruction. ' +
  'Output only the text to insert: no preamble, no explanations, no surrounding quotes, ' +
  'and no markdown unless the instruction asks for it.';

const COMPOSER_WIDTH = 560;
const COMPOSER_HEIGHT: Record<ScreenSnapMode, number> = { chat: 500, write: 660 };
const CHAT_ACTIVE_HEIGHT = 720;

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
   * Called after "Open in GrowthOS": focus the main window and tell its renderer
   * to pull the session via `snap.takePendingOpen` (queued so a cold-starting
   * window does not miss it).
   */
  onOpenQueued?: () => void;
  /**
   * Start a real GrowthOS session for the in-place chat; resolves its id.
   * Must call `bind(sessionId)` before enqueueing the prompt so no early
   * stream events are dropped.
   */
  startChat?: (
    payload: ScreenSnapSubmitPayload,
    bind: (sessionId: string) => void
  ) => Promise<string>;
  continueChat?: (sessionId: string, text: string) => Promise<void>;
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
  ensureFieldFocused?: (field: NonNullable<ScreenSnapTarget['focusedField']>) => Promise<boolean>;
  pasteText?: (text: string) => Promise<PasteResult>;
  isAccessibilityTrusted?: (prompt: boolean) => boolean;
  writeClipboard?: (text: string) => void;
  /** Resolves true when Screen Recording is granted; otherwise runs the permission flow. */
  ensureScreenPermission?: () => Promise<boolean>;
}

export class ScreenSnapController {
  private activeShortcut: string | null = null;
  private capturing = false;
  private composer: BrowserWindow | null = null;
  private pendingState: ScreenSnapComposerState | null = null;
  private pendingOpenSessionId: string | null = null;
  private chatSessionId: string | null = null;
  private readonly forwardedPermissions = new Set<string>();
  private layout: ScreenSnapLayout = 'compose';
  private target: ScreenSnapTarget | null = null;
  private generateAbort: AbortController | null = null;
  private screenPermission: ScreenRecordingPermission | null = null;
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

    this.capturing = true;
    try {
      if (!(await this.ensureScreenPermission())) return;

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

  getChatSessionId(): string | null {
    return this.chatSessionId;
  }

  /** Start the in-place chat: a real GrowthOS session mirrored into the panel. */
  async startChat(
    payload: ScreenSnapSubmitPayload,
    options: ScreenSnapStartChatOptions = {}
  ): Promise<ScreenSnapChatResult> {
    if (!this.options.startChat) return { success: false, error: 'Chat unavailable' };
    if (!payload?.image?.base64) return { success: false, error: 'Missing image' };
    if (options.restart) {
      this.chatSessionId = null;
      this.forwardedPermissions.clear();
    }
    if (this.chatSessionId) return { success: true, sessionId: this.chatSessionId };
    const composer = this.composer;
    try {
      const sessionId = await this.options.startChat(
        { text: typeof payload.text === 'string' ? payload.text : '', image: payload.image },
        (id) => {
          if (this.composer === composer) {
            this.chatSessionId = id;
            this.setLayout('chat-active');
          }
        }
      );
      return { success: true, sessionId };
    } catch (error) {
      if (this.composer === composer) {
        this.resetChat();
        this.resizeComposer();
      }
      logError('[ScreenSnap] Failed to start chat:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async continueChat(text: string): Promise<{ success: boolean; error?: string }> {
    const sessionId = this.chatSessionId;
    if (!sessionId || !this.options.continueChat) {
      return { success: false, error: 'No active chat' };
    }
    if (!text?.trim()) return { success: false, error: 'Empty message' };
    try {
      await this.options.continueChat(sessionId, text.trim());
      return { success: true };
    } catch (error) {
      logError('[ScreenSnap] Failed to continue chat:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Hand the in-place chat over to the main window and close the panel. */
  openInGrowthOS(): boolean {
    const sessionId = this.chatSessionId;
    if (!sessionId) return false;
    this.pendingOpenSessionId = sessionId;
    this.closeComposer();
    this.options.onOpenQueued?.();
    return true;
  }

  takePendingOpen(): string | null {
    const pending = this.pendingOpenSessionId;
    this.pendingOpenSessionId = null;
    return pending;
  }

  /** Mirror events for the panel's chat session into the panel. */
  forwardSessionEvent(event: { type: string; payload?: unknown }): void {
    const sessionId = this.chatSessionId;
    if (!sessionId || !this.composer || this.composer.isDestroyed()) return;
    if (!(SNAP_FORWARDED_EVENT_TYPES as readonly string[]).includes(event.type)) return;
    const payload = event.payload as { sessionId?: string; toolUseId?: string } | undefined;
    if (event.type === 'permission.dismiss') {
      // Dismissals carry no sessionId; match the requests we forwarded.
      if (!payload?.toolUseId || !this.forwardedPermissions.delete(payload.toolUseId)) return;
      this.composer.webContents.send('snap:sessionEvent', {
        ...event,
        payload: { ...payload, sessionId },
      });
      return;
    }
    if (payload?.sessionId !== sessionId) return;
    if (event.type === 'permission.request' && payload.toolUseId) {
      this.forwardedPermissions.add(payload.toolUseId);
    }
    this.composer.webContents.send('snap:sessionEvent', event);
  }

  setLayout(layout: ScreenSnapLayout): void {
    if (layout !== 'compose' && layout !== 'chat-active') return;
    this.layout = layout;
    this.resizeComposer();
  }

  setMode(mode: ScreenSnapMode): void {
    if (mode !== 'chat' && mode !== 'write') return;
    this.options.persistMode?.(mode);
    if (this.pendingState) this.pendingState = { ...this.pendingState, mode };
    this.resizeComposer();
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
      logWarn('[ScreenSnap] Could not re-activate target', target.bundleId);
      writeClipboard(text);
      this.showComposer();
      return { success: false, reason: 'target_unavailable' };
    }

    if (target.focusedField) {
      const ensureField =
        this.options.ensureFieldFocused ??
        ((field: NonNullable<ScreenSnapTarget['focusedField']>) =>
          defaultEnsureFieldFocused(field));
      if (!(await ensureField(target.focusedField))) {
        writeClipboard(text);
        this.showComposer();
        return { success: false, reason: 'no_field' };
      }
    }

    const paste = this.options.pasteText ?? ((value: string) => defaultPasteText(value));
    const result = await paste(text);
    if (!result.success) {
      logWarn('[ScreenSnap] Paste failed', target.bundleId, result.reason);
      this.showComposer();
      return { success: false, reason: result.reason };
    }
    log('[ScreenSnap] Pasted into', target.bundleId, `${text.length} chars`);
    this.closeComposer();
    return { success: true };
  }

  registerIpc(): void {
    ipcMain.handle('snap.getPendingState', () => this.pendingState);
    ipcMain.handle(
      'snap.startChat',
      (_event, payload: ScreenSnapSubmitPayload, options?: ScreenSnapStartChatOptions) =>
        this.startChat(payload, { restart: options?.restart === true })
    );
    ipcMain.handle('snap.continueChat', (_event, text: string) =>
      this.continueChat(typeof text === 'string' ? text : '')
    );
    ipcMain.handle('snap.openInGrowthOS', () => ({ success: this.openInGrowthOS() }));
    ipcMain.handle('snap.takePendingOpen', () => this.takePendingOpen());
    ipcMain.handle('snap.requestKeyboard', () => {
      this.grantKeyboard();
      return { success: true };
    });
    ipcMain.handle('snap.setLayout', (_event, layout: ScreenSnapLayout) => {
      this.setLayout(layout);
      return { success: true };
    });
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
      if (mode === 'chat') this.grantKeyboard();
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
    this.screenPermission?.dispose();
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

  private ensureScreenPermission(): Promise<boolean> {
    if (this.options.ensureScreenPermission) return this.options.ensureScreenPermission();
    this.screenPermission ??= new ScreenRecordingPermission();
    return this.screenPermission.ensure();
  }

  private showComposer(): void {
    if (this.composer && !this.composer.isDestroyed()) {
      this.revealComposer(this.composer);
    }
  }

  /**
   * Show the panel; never `app.focus()`, which would switch Spaces. In write
   * mode the panel stays non-key so the snapped app keeps its focused field
   * (many web editors close on blur); it takes the keyboard only once the user
   * clicks into one of its text boxes (`snap.requestKeyboard`).
   */
  private revealComposer(win: BrowserWindow): void {
    if (this.platform === 'darwin' && this.pendingState?.mode === 'write') {
      win.setFocusable(false);
      win.showInactive();
      return;
    }
    win.setFocusable(true);
    win.show();
    win.focus();
    win.webContents.focus();
  }

  private grantKeyboard(): void {
    const win = this.composer;
    if (!win || win.isDestroyed()) return;
    win.setFocusable(true);
    win.focus();
    win.webContents.focus();
  }

  private resetChat(): void {
    this.chatSessionId = null;
    this.forwardedPermissions.clear();
    this.layout = 'compose';
  }

  private composerHeight(mode: ScreenSnapMode): number {
    return this.layout === 'chat-active' ? CHAT_ACTIVE_HEIGHT : COMPOSER_HEIGHT[mode];
  }

  /** Centered on the display under the cursor. */
  private composerBounds(mode: ScreenSnapMode): Electron.Rectangle {
    const cursor = screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayNearestPoint(cursor);
    const height = Math.min(this.composerHeight(mode), workArea.height);
    return {
      x: Math.round(workArea.x + (workArea.width - COMPOSER_WIDTH) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width: COMPOSER_WIDTH,
      height,
    };
  }

  /** Resize in place (keeps the panel where the user dragged it), clamped to its display. */
  private resizeComposer(): void {
    const win = this.composer;
    if (!win || win.isDestroyed()) return;
    const mode = this.pendingState?.mode ?? 'chat';
    const current = win.getBounds();
    const { workArea } = screen.getDisplayMatching(current);
    const height = Math.min(this.composerHeight(mode), workArea.height);
    const centerY = current.y + current.height / 2;
    const y = Math.round(
      Math.min(Math.max(centerY - height / 2, workArea.y), workArea.y + workArea.height - height)
    );
    win.setResizable(this.layout === 'chat-active');
    win.setBounds({ x: current.x, y, width: current.width, height });
  }

  private openComposer(state: ScreenSnapComposerState): void {
    this.cancelGenerate();
    this.resetChat();
    this.pendingState = state;
    const bounds = this.composerBounds(state.mode);

    if (this.composer && !this.composer.isDestroyed()) {
      this.composer.setResizable(false);
      this.composer.setBounds(bounds);
      this.composer.webContents.send('snap:image', state);
      this.showComposer();
      return;
    }

    const win = new BrowserWindow({
      ...bounds,
      // Non-activating NSPanel: takes keyboard focus without activating GrowthOS,
      // so macOS does not switch Spaces and the snapped app stays frontmost.
      type: this.platform === 'darwin' ? 'panel' : undefined,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      minWidth: 420,
      minHeight: 360,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Buttons must work on the first click while the write-mode panel is not key.
      acceptFirstMouse: true,
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
    // Without skipTransformProcessType Electron flips the process type, which makes macOS switch Spaces.
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    win.once('ready-to-show', () => this.revealComposer(win));
    win.webContents.on('did-finish-load', () => {
      if (this.pendingState) {
        win.webContents.send('snap:image', this.pendingState);
      }
    });
    win.on('closed', () => {
      if (this.composer === win) {
        this.composer = null;
        this.pendingState = null;
        this.resetChat();
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
    this.resetChat();
    this.cancelGenerate();
    if (win && !win.isDestroyed()) {
      win.close();
    }
  }
}
