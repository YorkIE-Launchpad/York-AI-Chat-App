/**
 * Voice control session lifecycle (macOS): a small always-on-top overlay that
 * owns the Realtime WebRTC session, plus the global hotkey and deep-link entry
 * points. The overlay never takes focus, so actions land in the user's app.
 */
import {
  BrowserWindow,
  clipboard,
  globalShortcut as electronGlobalShortcut,
  ipcMain,
  screen,
  shell,
} from 'electron';
import {
  validateScreenSnapAccelerator,
  type ScreenSnapShortcutResult,
} from '../../shared/screen-snap';
import type {
  VoiceActionResult,
  VoiceControlConfig,
  VoiceDraftUpdate,
  VoiceDeepLinkAction,
  VoiceOverlayInit,
  VoiceSessionCredentials,
  VoiceTriggerSource,
} from '../../shared/voice-control';
import { log, logError, logWarn } from '../utils/logger';
import type { GlobalShortcutLike } from '../snap/screen-snap';
import { runVoiceAction } from './voice-actions';
import type { VoiceScreenDeps } from './screen-context';
import type { VoiceAssistantDeps } from './voice-assistant';
import type { VoiceModelDeps } from './voice-model';
import { createVoiceSession } from './voice-session-service';

const OVERLAY_WIDTH = 380;
const OVERLAY_HEIGHT = 132;
/** Room for the draft card under the pill. */
const OVERLAY_DRAFT_HEIGHT = 380;
const HISTORY_MAX = 16;
const HISTORY_LINE_MAX = 300;

function describeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const values = Object.entries(args as Record<string, unknown>)
    .filter(
      ([key, value]) =>
        key !== 'confirmed' && (typeof value === 'string' || typeof value === 'number')
    )
    .map(([, value]) => String(value));
  return values.length > 0 ? ` (${values.join(', ')})` : '';
}
const OVERLAY_TOP_MARGIN = 12;
/** Close the overlay ourselves if the renderer never acknowledges a stop. */
const STOP_FALLBACK_MS = 1500;
const ESCAPE_ACCELERATOR = 'Escape';
const MICROPHONE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

export interface VoiceControllerOptions {
  getConfig: () => VoiceControlConfig;
  persistHotkey: (hotkey: string | null) => void;
  loadOverlay: (win: BrowserWindow) => Promise<void>;
  preloadPath?: string;
  platform?: NodeJS.Platform;
  globalShortcut?: GlobalShortcutLike;
  createSession?: () => Promise<VoiceSessionCredentials>;
  runAction?: (name: string, args: unknown) => Promise<VoiceActionResult>;
  /** Vision call for the screen-aware `click` / `write` tools. */
  screen?: VoiceScreenDeps;
  /** Backs the `set_model` / `get_model` tools. */
  models?: VoiceModelDeps;
  /** Backs web search, page reading, opening links, and `ask_growthos`. */
  assistant?: VoiceAssistantDeps;
  onSessionStart?: () => void;
  onSessionActiveChanged?: (active: boolean) => void;
  onHotkeyChanged?: (hotkey: string | null) => void;
}

export class VoiceController {
  private overlay: BrowserWindow | null = null;
  private source: VoiceTriggerSource = 'hotkey';
  private activeHotkey: string | null = null;
  private escapeRegistered = false;
  private stopTimer: NodeJS.Timeout | null = null;
  /** This session's spoken turns and action results, oldest first. */
  private history: string[] = [];
  private readonly platform: NodeJS.Platform;
  private readonly globalShortcut: GlobalShortcutLike;

  constructor(private readonly options: VoiceControllerOptions) {
    this.platform = options.platform ?? process.platform;
    this.globalShortcut = options.globalShortcut ?? electronGlobalShortcut;
  }

  get isSupported(): boolean {
    return this.platform === 'darwin';
  }

  get isSessionActive(): boolean {
    return Boolean(this.overlay && !this.overlay.isDestroyed());
  }

  getHotkey(): string | null {
    return this.activeHotkey;
  }

  start(source: VoiceTriggerSource): void {
    if (!this.isSupported) return;
    if (!this.options.getConfig().enabled) {
      log('[Voice] Ignoring trigger; voice control is disabled', source);
      return;
    }
    if (this.isSessionActive) return;
    this.source = source;
    this.history = [];
    this.options.onSessionStart?.();
    log('[Voice] Starting session from', source);
    this.openOverlay();
  }

  stop(): void {
    const win = this.overlay;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('voice:stop');
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.closeOverlay(), STOP_FALLBACK_MS);
  }

  toggle(source: VoiceTriggerSource): void {
    if (this.isSessionActive) this.stop();
    else this.start(source);
  }

  handleDeepLink(action: VoiceDeepLinkAction): void {
    if (action === 'stop') this.stop();
    else if (action === 'toggle') this.toggle('siri');
    else this.start('siri');
  }

  /** Register the configured hotkey at startup. Returns false on conflict. */
  registerHotkey(hotkey: string | null): boolean {
    if (!this.isSupported) return false;
    this.unregisterHotkey();
    if (hotkey === null) return true;
    if (!this.tryRegisterHotkey(hotkey)) {
      log('[Voice] Failed to register hotkey', hotkey);
      return false;
    }
    this.activeHotkey = hotkey;
    return true;
  }

  /** Change the hotkey from Settings; rolls back to the previous one on failure. */
  setHotkey(hotkey: string | null): ScreenSnapShortcutResult {
    const previous = this.activeHotkey;
    if (!this.isSupported) return { success: false, reason: 'invalid', shortcut: previous };
    if (hotkey === null) {
      this.unregisterHotkey();
      this.options.persistHotkey(null);
      this.options.onHotkeyChanged?.(null);
      return { success: true, shortcut: null };
    }
    const validation = validateScreenSnapAccelerator(hotkey);
    if (!validation.ok) return { success: false, reason: validation.reason, shortcut: previous };

    this.unregisterHotkey();
    if (!this.tryRegisterHotkey(hotkey)) {
      if (previous && this.tryRegisterHotkey(previous)) this.activeHotkey = previous;
      return { success: false, reason: 'conflict', shortcut: this.activeHotkey };
    }
    this.activeHotkey = hotkey;
    this.options.persistHotkey(hotkey);
    this.options.onHotkeyChanged?.(hotkey);
    return { success: true, shortcut: hotkey };
  }

  registerIpc(): void {
    ipcMain.handle(
      'voice.getOverlayInit',
      (): VoiceOverlayInit => ({
        source: this.source,
        followUpSeconds: this.options.getConfig().followUpSeconds,
      })
    );
    ipcMain.handle('voice.createSession', () =>
      (this.options.createSession ?? createVoiceSession)()
    );
    ipcMain.handle('voice.runAction', (_event, name: unknown, args: unknown) =>
      this.runAction(typeof name === 'string' ? name : '', args)
    );
    ipcMain.handle('voice.sessionEnded', () => {
      this.closeOverlay();
      return { success: true };
    });
    ipcMain.handle('voice.trigger', (_event, source: unknown) => {
      this.start(source === 'settings' ? 'settings' : 'menu');
      return { success: true };
    });
    ipcMain.handle('voice.stop', () => {
      this.stop();
      return { success: true };
    });
    ipcMain.handle('voice.getHotkey', () => ({
      hotkey: this.activeHotkey,
      supported: this.isSupported,
    }));
    ipcMain.handle('voice.setHotkey', (_event, hotkey: unknown) =>
      this.setHotkey(typeof hotkey === 'string' ? hotkey : null)
    );
    ipcMain.handle('voice.noteTurn', (_event, role: unknown, text: unknown) => {
      if ((role === 'user' || role === 'assistant') && typeof text === 'string') {
        this.noteHistory(`${role === 'user' ? 'User' : 'Assistant'}: ${text}`);
      }
      return { success: true };
    });
    ipcMain.handle('voice.copyDraft', (_event, text: unknown) => {
      if (typeof text === 'string' && text) clipboard.writeText(text);
      return { success: true };
    });
    ipcMain.handle('voice.dismissDraft', () => {
      this.setOverlayHeight(OVERLAY_HEIGHT);
      return { success: true };
    });
    ipcMain.handle('voice.openMicrophoneSettings', async () => {
      await shell.openExternal(MICROPHONE_SETTINGS_URL);
      return { success: true };
    });
  }

  dispose(): void {
    this.unregisterHotkey();
    this.closeOverlay();
  }

  private async runAction(name: string, args: unknown): Promise<VoiceActionResult> {
    log('[Voice] Action', name);
    // A synthesized Escape keystroke must reach the target app, not our close shortcut.
    this.setEscapeRegistered(false);
    try {
      if (this.options.runAction) return await this.options.runAction(name, args);
      const screenDeps = this.options.screen;
      const result = await runVoiceAction(name, args, {
        screen: screenDeps && {
          ...screenDeps,
          getHistory: () => [...this.history],
          onProgress: (text) => this.sendToOverlay('voice:progress', text),
          onDraft: (update) => this.showDraft(update),
        },
        models: this.options.models,
        assistant: this.options.assistant && {
          ...this.options.assistant,
          onProgress: (text) => this.sendToOverlay('voice:progress', text),
        },
      });
      this.noteHistory(`Action ${name}${describeArgs(args)} -> ${result.message}`);
      return result;
    } finally {
      if (this.isSessionActive) this.setEscapeRegistered(true);
    }
  }

  private noteHistory(line: string): void {
    const trimmed = line.replace(/\s+/g, ' ').trim().slice(0, HISTORY_LINE_MAX);
    if (!trimmed) return;
    this.history.push(trimmed);
    if (this.history.length > HISTORY_MAX)
      this.history.splice(0, this.history.length - HISTORY_MAX);
  }

  private sendToOverlay(channel: string, payload: unknown): void {
    const win = this.overlay;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  private showDraft(update: VoiceDraftUpdate): void {
    if (!this.isSessionActive) return;
    this.setOverlayHeight(OVERLAY_DRAFT_HEIGHT);
    this.sendToOverlay('voice:draft', update);
  }

  /** Grows downward from the pill's current position, clamped to its display. */
  private setOverlayHeight(height: number): void {
    const win = this.overlay;
    if (!win || win.isDestroyed()) return;
    const current = win.getBounds();
    if (current.height === height) return;
    const { workArea } = screen.getDisplayMatching(current);
    const clamped = Math.min(height, workArea.y + workArea.height - current.y);
    win.setBounds({ ...current, height: clamped });
  }

  private tryRegisterHotkey(accelerator: string): boolean {
    try {
      return this.globalShortcut.register(accelerator, () => this.toggle('hotkey'));
    } catch (error) {
      logWarn('[Voice] Invalid accelerator', accelerator, error);
      return false;
    }
  }

  private unregisterHotkey(): void {
    if (!this.activeHotkey) return;
    try {
      this.globalShortcut.unregister(this.activeHotkey);
    } catch (error) {
      logWarn('[Voice] Failed to unregister hotkey', this.activeHotkey, error);
    }
    this.activeHotkey = null;
  }

  private setEscapeRegistered(registered: boolean): void {
    if (registered === this.escapeRegistered) return;
    try {
      if (registered) {
        this.escapeRegistered = this.globalShortcut.register(ESCAPE_ACCELERATOR, () => this.stop());
      } else {
        this.globalShortcut.unregister(ESCAPE_ACCELERATOR);
        this.escapeRegistered = false;
      }
    } catch (error) {
      logWarn('[Voice] Escape shortcut toggle failed', error);
      this.escapeRegistered = false;
    }
  }

  /** Top-centre of the display under the cursor. */
  private overlayBounds(): Electron.Rectangle {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return {
      x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
      y: workArea.y + OVERLAY_TOP_MARGIN,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    };
  }

  private openOverlay(): void {
    const win = new BrowserWindow({
      ...this.overlayBounds(),
      type: this.platform === 'darwin' ? 'panel' : undefined,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    // Keeps the pill out of the screenshots `click` / `write` send to the model.
    win.setContentProtection(true);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.showInactive();
    });
    win.on('closed', () => {
      if (this.overlay !== win) return;
      this.overlay = null;
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
      this.setEscapeRegistered(false);
      this.options.onSessionActiveChanged?.(false);
    });
    this.overlay = win;
    this.setEscapeRegistered(true);
    this.options.onSessionActiveChanged?.(true);

    void this.options.loadOverlay(win).catch((error: unknown) => {
      logError('[Voice] Failed to load overlay:', error);
      this.closeOverlay();
    });
  }

  private closeOverlay(): void {
    const win = this.overlay;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (win && !win.isDestroyed()) win.close();
  }
}
