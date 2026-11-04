/**
 * Phase 2: system-wide voice buttons.
 * macOS hold/release via native helper. Windows toggle via globalShortcut.
 * Overlay captures audio without taking focus, then pastes into the frontmost app.
 */
import { BrowserWindow, globalShortcut as electronGlobalShortcut, ipcMain, screen } from 'electron';
import type { VoiceButtonsConfig } from '../../shared/voice-buttons';
import { pasteText, type PasteResult } from '../snap/paste-into-app';
import type { GlobalShortcutLike } from '../snap/screen-snap';
import { log, logError, logWarn } from '../utils/logger';
import { VoiceHotkeyMonitor } from './voice-hotkey-monitor';

const OVERLAY_WIDTH = 340;
const OVERLAY_HEIGHT = 148;
const OVERLAY_TOP_MARGIN = 16;

export interface VoiceButtonsControllerOptions {
  getConfig: () => VoiceButtonsConfig;
  loadOverlay: (win: BrowserWindow) => Promise<void>;
  preloadPath?: string;
  platform?: NodeJS.Platform;
  globalShortcut?: GlobalShortcutLike;
  pasteText?: (text: string) => Promise<PasteResult>;
  onHotkeyError?: (message: string) => void;
}

export class VoiceButtonsController {
  private overlay: BrowserWindow | null = null;
  private windowsHotkey: string | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly globalShortcut: GlobalShortcutLike;
  private readonly monitor: VoiceHotkeyMonitor;
  private holding = false;

  constructor(private readonly options: VoiceButtonsControllerOptions) {
    this.platform = options.platform ?? process.platform;
    this.globalShortcut = options.globalShortcut ?? electronGlobalShortcut;
    this.monitor = new VoiceHotkeyMonitor((type, message) => this.onMonitorEvent(type, message));
  }

  get isSupported(): boolean {
    return this.platform === 'darwin' || this.platform === 'win32';
  }

  get isSessionActive(): boolean {
    return Boolean(this.overlay && !this.overlay.isDestroyed());
  }

  /** Sync hotkey helper / toggle with the current config. */
  syncFromConfig(): void {
    const config = this.options.getConfig();
    if (!config.enabled || !config.systemWide || !config.hotkeyEnabled || !config.hotkey) {
      this.stopHotkeys();
      return;
    }
    this.startHotkeys(config.hotkey);
  }

  registerIpc(): void {
    ipcMain.handle('voiceButtons.system.paste', async (_event, text: unknown) => {
      if (typeof text !== 'string' || !text.trim()) {
        return { success: false, reason: 'failed' } satisfies PasteResult;
      }
      const paste = this.options.pasteText ?? ((value: string) => pasteText(value));
      return paste(text);
    });

    ipcMain.handle('voiceButtons.system.sessionEnded', () => {
      this.closeOverlay();
      return { success: true };
    });

    ipcMain.handle('voiceButtons.system.getStatus', () => ({
      supported: this.isSupported,
      holdToTalk: this.platform === 'darwin',
      active: this.isSessionActive,
      helperRunning: this.monitor.isRunning || Boolean(this.windowsHotkey),
    }));
  }

  dispose(): void {
    this.stopHotkeys();
    this.closeOverlay();
  }

  private startHotkeys(accelerator: string): void {
    if (this.platform === 'darwin') {
      if (this.monitor.isRunning) {
        this.monitor.stop();
      }
      const ok = this.monitor.start(accelerator);
      if (!ok) logWarn('[VoiceButtons] System-wide hold key did not start');
      return;
    }
    if (this.platform === 'win32') {
      this.unregisterWindowsHotkey();
      try {
        const ok = this.globalShortcut.register(accelerator, () => this.toggleFromHotkey());
        if (ok) this.windowsHotkey = accelerator;
        else logWarn('[VoiceButtons] Windows hotkey conflict', accelerator);
      } catch (error) {
        logWarn('[VoiceButtons] Windows hotkey failed', accelerator, error);
      }
    }
  }

  private stopHotkeys(): void {
    this.monitor.stop();
    this.unregisterWindowsHotkey();
    this.holding = false;
  }

  private unregisterWindowsHotkey(): void {
    if (!this.windowsHotkey) return;
    try {
      this.globalShortcut.unregister(this.windowsHotkey);
    } catch (error) {
      logWarn('[VoiceButtons] Failed to unregister Windows hotkey', error);
    }
    this.windowsHotkey = null;
  }

  private onMonitorEvent(type: 'ready' | 'down' | 'up' | 'error', message?: string): void {
    if (type === 'ready') {
      log('[VoiceButtons] Hold-key helper ready');
      return;
    }
    if (type === 'error') {
      logWarn('[VoiceButtons] Hold-key helper error', message);
      this.options.onHotkeyError?.(message || 'Hold-key helper error');
      return;
    }
    if (type === 'down') {
      if (this.holding) return;
      this.holding = true;
      this.openOverlay('hold');
      return;
    }
    if (type === 'up') {
      if (!this.holding) return;
      this.holding = false;
      this.sendToOverlay('voiceButtons:systemStop');
    }
  }

  private toggleFromHotkey(): void {
    if (this.isSessionActive) {
      this.sendToOverlay('voiceButtons:systemStop');
      return;
    }
    this.openOverlay('toggle');
  }

  private overlayBounds(): Electron.Rectangle {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return {
      x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
      y: workArea.y + OVERLAY_TOP_MARGIN,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    };
  }

  private openOverlay(mode: 'hold' | 'toggle'): void {
    if (this.isSessionActive) {
      this.sendToOverlay('voiceButtons:systemStart', { mode });
      return;
    }
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
    win.setContentProtection(true);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.showInactive();
        win.webContents.send('voiceButtons:systemStart', { mode });
      }
    });
    win.on('closed', () => {
      if (this.overlay === win) this.overlay = null;
      this.holding = false;
    });
    this.overlay = win;
    void this.options.loadOverlay(win).catch((error: unknown) => {
      logError('[VoiceButtons] Failed to load system overlay', error);
      this.closeOverlay();
    });
  }

  private sendToOverlay(channel: string, payload?: unknown): void {
    const win = this.overlay;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  private closeOverlay(): void {
    const win = this.overlay;
    this.overlay = null;
    this.holding = false;
    if (win && !win.isDestroyed()) win.close();
  }
}
