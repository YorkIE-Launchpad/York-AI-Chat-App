import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
    }),
  },
  clipboard: {},
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => true) },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { normalizeVoiceButtonsConfig } from '../../shared/voice-buttons';
import { pasteText } from '../../main/snap/paste-into-app';
import { VoiceButtonsController } from '../../main/voice-buttons/voice-buttons-controller';
import type { NativeImage } from 'electron';

describe('voice buttons phase 2 config', () => {
  it('defaults system-wide on so enabling the feature works outside GrowthOS', () => {
    expect(normalizeVoiceButtonsConfig(undefined).systemWide).toBe(true);
    expect(normalizeVoiceButtonsConfig({ systemWide: false }).systemWide).toBe(false);
  });
});

describe('pasteText windows path', () => {
  it('pastes with Ctrl+V on Windows without Accessibility checks', async () => {
    const state = { text: 'old', html: '', rtf: '' };
    const emptyImage = { isEmpty: () => true } as unknown as NativeImage;
    const cb = {
      readText: () => state.text,
      readHTML: () => state.html,
      readRTF: () => state.rtf,
      readImage: () => emptyImage,
      writeText: (text: string) => {
        state.text = text;
      },
      write: (data: { text?: string }) => {
        state.text = data.text ?? '';
      },
      clear: () => {
        state.text = '';
      },
    };
    const runWindowsPaste = vi.fn(async () => undefined);
    const result = await pasteText('hello from voice', {
      clipboard: cb,
      platform: 'win32',
      runWindowsPaste,
      schedule: () => undefined,
    });
    expect(result).toEqual({ success: true });
    expect(runWindowsPaste).toHaveBeenCalledTimes(1);
    expect(state.text).toBe('hello from voice');
  });
});

describe('VoiceButtonsController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a Windows toggle hotkey when system-wide is on', () => {
    const register = vi.fn(() => true);
    const unregister = vi.fn();
    const controller = new VoiceButtonsController({
      platform: 'win32',
      globalShortcut: { register, unregister },
      getConfig: () =>
        normalizeVoiceButtonsConfig({
          enabled: true,
          systemWide: true,
          hotkeyEnabled: true,
          hotkey: 'Control+Shift+D',
        }),
      loadOverlay: async () => undefined,
    });
    controller.syncFromConfig();
    expect(register).toHaveBeenCalledWith('Control+Shift+D', expect.any(Function));
    controller.dispose();
    expect(unregister).toHaveBeenCalledWith('Control+Shift+D');
  });

  it('does not register hotkeys when the feature is off', () => {
    const register = vi.fn(() => true);
    const controller = new VoiceButtonsController({
      platform: 'win32',
      globalShortcut: { register, unregister: vi.fn() },
      getConfig: () => normalizeVoiceButtonsConfig({ enabled: false, systemWide: true }),
      loadOverlay: async () => undefined,
    });
    controller.syncFromConfig();
    expect(register).not.toHaveBeenCalled();
    controller.dispose();
  });
});
