import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';

vi.mock('electron', () => ({
  clipboard: {},
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => false) },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  CLIPBOARD_RESTORE_DELAY_MS,
  pasteText,
  type ClipboardLike,
} from '../../main/snap/paste-into-app';

function createClipboard(initial: { text?: string; html?: string } = {}) {
  const state = { text: initial.text ?? '', html: initial.html ?? '', rtf: '' };
  const emptyImage = { isEmpty: () => true } as unknown as NativeImage;
  const cb = {
    readText: vi.fn(() => state.text),
    readHTML: vi.fn(() => state.html),
    readRTF: vi.fn(() => state.rtf),
    readImage: vi.fn(() => emptyImage),
    writeText: vi.fn((text: string) => {
      state.text = text;
      state.html = '';
    }),
    write: vi.fn((data: { text?: string; html?: string }) => {
      state.text = data.text ?? '';
      state.html = data.html ?? '';
    }),
    clear: vi.fn(() => {
      state.text = '';
      state.html = '';
    }),
  } satisfies ClipboardLike;
  return { cb, state };
}

describe('pasteText', () => {
  let scheduled: Array<{ fn: () => void; ms: number }>;
  const schedule = (fn: () => void, ms: number) => {
    scheduled.push({ fn, ms });
  };

  beforeEach(() => {
    scheduled = [];
  });

  it('pastes with Cmd+V and restores the previous clipboard afterwards', async () => {
    const { cb, state } = createClipboard({ text: 'previous', html: '<b>previous</b>' });
    const run = vi.fn(async (_args: string[]) => '');

    const result = await pasteText('summary', {
      clipboard: cb,
      isTrusted: () => true,
      runOsascript: run,
      schedule,
    });

    expect(result).toEqual({ success: true });
    expect(cb.writeText).toHaveBeenCalledWith('summary');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].join(' ')).toContain('keystroke "v" using command down');
    expect(state.text).toBe('summary');

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(CLIPBOARD_RESTORE_DELAY_MS);
    scheduled[0].fn();
    expect(cb.write).toHaveBeenCalledWith({ text: 'previous', html: '<b>previous</b>' });
    expect(state.text).toBe('previous');
  });

  it('clears the clipboard on restore when it was empty before', async () => {
    const { cb } = createClipboard();
    await pasteText('summary', {
      clipboard: cb,
      isTrusted: () => true,
      runOsascript: async () => '',
      schedule,
    });
    scheduled[0].fn();
    expect(cb.clear).toHaveBeenCalled();
  });

  it('leaves the text on the clipboard without a keystroke when Accessibility is missing', async () => {
    const { cb, state } = createClipboard({ text: 'previous' });
    const run = vi.fn(async () => '');
    const isTrusted = vi.fn(() => false);

    const result = await pasteText('summary', {
      clipboard: cb,
      isTrusted,
      runOsascript: run,
      schedule,
    });

    expect(result).toEqual({ success: false, reason: 'accessibility' });
    expect(isTrusted).toHaveBeenCalledWith(true);
    expect(run).not.toHaveBeenCalled();
    expect(state.text).toBe('summary');
    expect(scheduled).toHaveLength(0);
  });

  it('does not restore when the user copied something else meanwhile', async () => {
    const { cb, state } = createClipboard({ text: 'previous' });
    await pasteText('summary', {
      clipboard: cb,
      isTrusted: () => true,
      runOsascript: async () => '',
      schedule,
    });

    state.text = 'user copied this';
    scheduled[0].fn();

    expect(cb.write).not.toHaveBeenCalled();
    expect(cb.clear).not.toHaveBeenCalled();
    expect(state.text).toBe('user copied this');
  });

  it('reports failure and keeps the text on the clipboard when the keystroke fails', async () => {
    const { cb, state } = createClipboard({ text: 'previous' });
    const run = vi.fn(async () => {
      throw new Error('not permitted');
    });

    const result = await pasteText('summary', {
      clipboard: cb,
      isTrusted: () => true,
      runOsascript: run,
      schedule,
    });

    expect(result).toEqual({ success: false, reason: 'failed' });
    expect(state.text).toBe('summary');
    expect(scheduled).toHaveLength(0);
  });
});
