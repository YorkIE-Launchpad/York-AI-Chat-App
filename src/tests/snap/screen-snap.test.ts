import * as fs from 'fs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const resizeMock = vi.fn();
const windowEvents: string[] = [];

vi.mock('electron', () => {
  class FakeWindow {
    private destroyed = false;
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    };
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setBounds = vi.fn();
    once = vi.fn();
    on = vi.fn();
    focus = vi.fn();
    isDestroyed = () => this.destroyed;
    show = vi.fn(() => windowEvents.push('show'));
    hide = vi.fn(() => windowEvents.push('hide'));
    close = vi.fn(() => {
      windowEvents.push('close');
      this.destroyed = true;
    });
  }
  const makeImage = (width: number, height: number) => ({
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (opts: { width?: number; height?: number }) => {
      resizeMock(opts);
      const scale = (opts.width ?? opts.height ?? width) / (opts.width ? width : height);
      return makeImage(Math.round(width * scale), Math.round(height * scale));
    },
    toJPEG: () => Buffer.from('jpeg-bytes'),
  });
  return {
    nativeImage: {
      createFromBuffer: (buf: Buffer) =>
        buf.length > 1024 ? makeImage(5120, 2880) : makeImage(400, 300),
    },
    BrowserWindow: FakeWindow,
    clipboard: { writeText: vi.fn() },
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    ipcMain: { handle: vi.fn() },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    shell: { openExternal: vi.fn() },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      isTrustedAccessibilityClient: () => false,
    },
  };
});

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  MAX_SNAP_IMAGE_BYTES,
  SNAP_DOWNSCALE_MAX_EDGE,
  ScreenSnapController,
  captureRect,
  captureRegion,
  type GlobalShortcutLike,
  type ScreenSnapControllerOptions,
} from '../../main/snap/screen-snap';
import type { ScreenSnapImage, ScreenSnapTarget } from '../../shared/screen-snap';

function outputPathFrom(args: string[]): string {
  return args[args.length - 1];
}

describe('captureRegion', () => {
  beforeEach(() => resizeMock.mockClear());

  it('returns null when the user cancels (no file written)', async () => {
    const exec = vi.fn(async () => undefined);
    await expect(captureRegion(exec)).resolves.toBeNull();
    expect(exec).toHaveBeenCalledWith('/usr/sbin/screencapture', expect.arrayContaining(['-i']));
  });

  it('returns null when screencapture errors without producing a file', async () => {
    const exec = vi.fn(async () => {
      throw new Error('cancelled');
    });
    await expect(captureRegion(exec)).resolves.toBeNull();
  });

  it('encodes a small capture as PNG and removes the temp file', async () => {
    let written = '';
    const exec = vi.fn(async (_file: string, args: string[]) => {
      written = outputPathFrom(args);
      fs.writeFileSync(written, Buffer.from('small-png'));
    });
    const image = await captureRegion(exec);
    expect(image).toEqual({
      base64: Buffer.from('small-png').toString('base64'),
      mediaType: 'image/png',
      width: 400,
      height: 300,
    });
    await vi.waitFor(() => expect(fs.existsSync(written)).toBe(false));
  });

  it('downscales oversized captures to JPEG', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      fs.writeFileSync(outputPathFrom(args), Buffer.alloc(Math.ceil(MAX_SNAP_IMAGE_BYTES) + 10));
    });
    const image = await captureRegion(exec);
    expect(image?.mediaType).toBe('image/jpeg');
    expect(image?.base64).toBe(Buffer.from('jpeg-bytes').toString('base64'));
    expect(resizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: SNAP_DOWNSCALE_MAX_EDGE })
    );
    expect(image?.width).toBe(SNAP_DOWNSCALE_MAX_EDGE);
  });
});

describe('ScreenSnapController shortcuts', () => {
  let registered: Set<string>;
  let taken: Set<string>;
  let globalShortcut: GlobalShortcutLike;
  let persistShortcut: Mock<(shortcut: string | null) => void>;
  let onShortcutChanged: Mock<(shortcut: string | null) => void>;

  const makeController = () =>
    new ScreenSnapController({
      platform: 'darwin',
      globalShortcut,
      persistShortcut,
      onShortcutChanged,
      capture: async () => null,
    });

  beforeEach(() => {
    registered = new Set();
    taken = new Set();
    globalShortcut = {
      register: (acc) => {
        if (taken.has(acc)) return false;
        registered.add(acc);
        return true;
      },
      unregister: (acc) => {
        registered.delete(acc);
      },
    };
    persistShortcut = vi.fn<(shortcut: string | null) => void>();
    onShortcutChanged = vi.fn<(shortcut: string | null) => void>();
  });

  it('registers the default shortcut when config has none', () => {
    const controller = makeController();
    expect(controller.registerShortcut(undefined)).toBe(true);
    expect(controller.getShortcut()).toBe('CommandOrControl+Shift+G');
    expect(registered.has('CommandOrControl+Shift+G')).toBe(true);
  });

  it('does not register anything on non-mac platforms', () => {
    const controller = new ScreenSnapController({
      platform: 'win32',
      globalShortcut,
      persistShortcut,
    });
    expect(controller.registerShortcut('Command+Shift+G')).toBe(false);
    expect(registered.size).toBe(0);
  });

  it('swaps to a new shortcut and persists it', () => {
    const controller = makeController();
    controller.registerShortcut('CommandOrControl+Shift+G');
    const result = controller.setShortcut('Control+Option+S');
    expect(result).toEqual({ success: true, shortcut: 'Control+Option+S' });
    expect(registered.has('CommandOrControl+Shift+G')).toBe(false);
    expect(registered.has('Control+Option+S')).toBe(true);
    expect(persistShortcut).toHaveBeenCalledWith('Control+Option+S');
    expect(onShortcutChanged).toHaveBeenCalledWith('Control+Option+S');
  });

  it('rolls back to the previous shortcut on conflict', () => {
    const controller = makeController();
    controller.registerShortcut('CommandOrControl+Shift+G');
    taken.add('Command+Option+K');
    const result = controller.setShortcut('Command+Option+K');
    expect(result).toEqual({
      success: false,
      reason: 'conflict',
      shortcut: 'CommandOrControl+Shift+G',
    });
    expect(registered.has('CommandOrControl+Shift+G')).toBe(true);
    expect(persistShortcut).not.toHaveBeenCalled();
  });

  it.each([
    ['Command+Shift+4', 'reserved'],
    ['Control+Command+Shift+3', 'reserved'],
    ['Command+Shift+Space', 'reserved'],
    ['Shift+G', 'invalid'],
    ['G', 'invalid'],
  ])('rejects %s as %s without touching the current shortcut', (acc, reason) => {
    const controller = makeController();
    controller.registerShortcut('CommandOrControl+Shift+G');
    const result = controller.setShortcut(acc);
    expect(result).toEqual({ success: false, reason, shortcut: 'CommandOrControl+Shift+G' });
    expect(registered.has('CommandOrControl+Shift+G')).toBe(true);
  });

  it('disables the shortcut with null', () => {
    const controller = makeController();
    controller.registerShortcut('CommandOrControl+Shift+G');
    expect(controller.setShortcut(null)).toEqual({ success: true, shortcut: null });
    expect(registered.size).toBe(0);
    expect(persistShortcut).toHaveBeenCalledWith(null);
  });
});

describe('ScreenSnapController submit queue', () => {
  const image: ScreenSnapImage = {
    base64: 'abc',
    mediaType: 'image/png',
    width: 10,
    height: 10,
  };

  it('queues a submit until the main window takes it', () => {
    const onSubmitQueued = vi.fn();
    const controller = new ScreenSnapController({
      platform: 'darwin',
      persistShortcut: vi.fn(),
      onSubmitQueued,
    });
    expect(controller.submit({ text: 'what is this?', image })).toBe(true);
    expect(onSubmitQueued).toHaveBeenCalledTimes(1);
    expect(controller.takePendingSubmit()).toEqual({ text: 'what is this?', image });
    expect(controller.takePendingSubmit()).toBeNull();
  });

  it('rejects a submit without image data', () => {
    const controller = new ScreenSnapController({ platform: 'darwin', persistShortcut: vi.fn() });
    expect(controller.submit({ text: 'hi', image: { ...image, base64: '' } })).toBe(false);
    expect(controller.takePendingSubmit()).toBeNull();
  });
});

describe('captureRect', () => {
  it('captures a fixed rectangle without interactive selection', async () => {
    const exec = vi.fn(async () => undefined);
    await captureRect({ x: 10.4, y: 20.6, width: 800, height: 600 }, exec);
    const args = (exec.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toContain('-R');
    expect(args).toContain('10,21,800,600');
    expect(args).not.toContain('-i');
  });
});

describe('ScreenSnapController write into field', () => {
  const image: ScreenSnapImage = { base64: 'abc', mediaType: 'image/png', width: 10, height: 10 };
  const chrome: ScreenSnapTarget = {
    bundleId: 'com.google.Chrome',
    name: 'Google Chrome',
    pid: 42,
    bounds: { x: 0, y: 25, width: 1200, height: 800 },
  };

  beforeEach(() => {
    windowEvents.length = 0;
  });

  const makeController = (overrides: Partial<ScreenSnapControllerOptions> = {}) => {
    const capture = vi.fn(async () => image);
    const captureRectFn = vi.fn(async () => image);
    const controller = new ScreenSnapController({
      platform: 'darwin',
      persistShortcut: vi.fn(),
      capture,
      captureRect: captureRectFn,
      getMode: () => 'write',
      getFrontmostTarget: async () => chrome,
      ...overrides,
    });
    return { controller, capture, captureRectFn };
  };

  const pendingState = (controller: ScreenSnapController) =>
    (controller as unknown as { pendingState: unknown }).pendingState;

  it('captures the front window in write mode when bounds are known', async () => {
    const { controller, capture, captureRectFn } = makeController();
    await controller.trigger();
    expect(captureRectFn).toHaveBeenCalledWith(chrome.bounds);
    expect(capture).not.toHaveBeenCalled();
    expect(pendingState(controller)).toEqual({
      image,
      mode: 'write',
      targetAppName: 'Google Chrome',
    });
  });

  it('falls back to region capture when the target has no window bounds', async () => {
    const { controller, capture, captureRectFn } = makeController({
      getFrontmostTarget: async () => ({ bundleId: 'com.apple.Notes', name: 'Notes', pid: 7 }),
    });
    await controller.trigger();
    expect(capture).toHaveBeenCalled();
    expect(captureRectFn).not.toHaveBeenCalled();
    expect(pendingState(controller)).toMatchObject({ mode: 'write', targetAppName: 'Notes' });
  });

  it('falls back to region capture and chat mode when there is no target app', async () => {
    const { controller, capture } = makeController({ getFrontmostTarget: async () => null });
    await controller.trigger();
    expect(capture).toHaveBeenCalled();
    expect(pendingState(controller)).toMatchObject({ mode: 'chat', targetAppName: null });
  });

  it('activates the target before pasting and closes the composer on success', async () => {
    const order: string[] = [];
    const { controller } = makeController({
      isAccessibilityTrusted: () => true,
      activateTarget: async (bundleId) => {
        order.push(`activate:${bundleId}`);
        return true;
      },
      pasteText: async (text) => {
        order.push(`paste:${text}`);
        return { success: true };
      },
    });
    await controller.trigger();
    await expect(controller.insert('Summary text')).resolves.toEqual({ success: true });
    expect(order).toEqual(['activate:com.google.Chrome', 'paste:Summary text']);
    expect(windowEvents).toEqual(['hide', 'close']);
  });

  it('keeps the composer open and copies when Accessibility is missing', async () => {
    const writeClipboard = vi.fn();
    const activateTarget = vi.fn(async () => true);
    const pasteText = vi.fn(async () => ({ success: true as const }));
    const { controller } = makeController({
      isAccessibilityTrusted: () => false,
      writeClipboard,
      activateTarget,
      pasteText,
    });
    await controller.trigger();
    await expect(controller.insert('Summary')).resolves.toEqual({
      success: false,
      reason: 'accessibility',
    });
    expect(writeClipboard).toHaveBeenCalledWith('Summary');
    expect(activateTarget).not.toHaveBeenCalled();
    expect(pasteText).not.toHaveBeenCalled();
    expect(windowEvents).not.toContain('hide');
    expect(windowEvents).not.toContain('close');
  });

  it('re-shows the composer when the target app cannot be activated', async () => {
    const writeClipboard = vi.fn();
    const { controller } = makeController({
      isAccessibilityTrusted: () => true,
      writeClipboard,
      activateTarget: async () => false,
    });
    await controller.trigger();
    await expect(controller.insert('Summary')).resolves.toEqual({
      success: false,
      reason: 'target_unavailable',
    });
    expect(writeClipboard).toHaveBeenCalledWith('Summary');
    expect(windowEvents).toEqual(['hide', 'show']);
  });

  it('copies and reports no_target when nothing was frontmost', async () => {
    const writeClipboard = vi.fn();
    const { controller } = makeController({ getFrontmostTarget: async () => null, writeClipboard });
    await controller.trigger();
    await expect(controller.insert('Summary')).resolves.toEqual({
      success: false,
      reason: 'no_target',
    });
    expect(writeClipboard).toHaveBeenCalledWith('Summary');
  });

  it('streams deltas and returns trimmed text', async () => {
    const deltas: string[] = [];
    const { controller } = makeController({
      generate: async (_request, onDelta) => {
        onDelta('Hel');
        onDelta('Hello');
        return '  Hello  ';
      },
    });
    await expect(
      controller.generate({ instruction: 'summarize', image }, (text) => deltas.push(text))
    ).resolves.toEqual({ success: true, text: 'Hello' });
    expect(deltas).toEqual(['Hel', 'Hello']);
  });

  it('cancels an in-flight generation', async () => {
    const { controller } = makeController({
      generate: (_request, _onDelta, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const pending = controller.generate({ instruction: 'summarize', image }, () => {});
    controller.cancelGenerate();
    await expect(pending).resolves.toEqual({ success: false, error: 'Cancelled', cancelled: true });
  });

  it('persists the mode and resizes the open composer', async () => {
    const persistMode = vi.fn();
    const { controller } = makeController({ persistMode });
    await controller.trigger();
    controller.setMode('chat');
    expect(persistMode).toHaveBeenCalledWith('chat');
    expect(pendingState(controller)).toMatchObject({ mode: 'chat' });
  });
});
