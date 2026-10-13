import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  clipboard: {},
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => true) },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  chordNeedsConfirmation,
  chordToOsascriptArgs,
  parseKeyChord,
  resolveInstalledApp,
  runVoiceAction,
} from '../../main/voice/voice-actions';

const APPS = [
  '/Applications/Slack.app',
  '/Applications/Google Chrome.app',
  '/Applications/Visual Studio Code.app',
  '/System/Applications/Notes.app',
  '/System/Applications/System Settings.app',
];

function deps(options: { trusted?: boolean; osascriptError?: Error } = {}) {
  return {
    runOsascript: vi.fn(async (_args: string[]) => {
      if (options.osascriptError) throw options.osascriptError;
      return '';
    }),
    openApp: vi.fn(async (_appPath: string) => undefined),
    listApps: () => APPS,
    pasteText: vi.fn(async (_text: string) => ({ success: true as const })),
    isTrusted: () => options.trusted ?? true,
  };
}

/** The AppleScript statement inside the generated repeat block. */
function actionLine(args: string[]): string {
  return args[7];
}

describe('parseKeyChord', () => {
  it('parses modifiers and a character', () => {
    expect(parseKeyChord('cmd+shift+t')).toEqual({
      modifiers: ['command', 'shift'],
      character: 't',
    });
  });

  it('maps named keys to key codes, including two-word names', () => {
    expect(parseKeyChord('escape')).toEqual({ modifiers: [], keyCode: 53 });
    expect(parseKeyChord('page down')).toEqual({ modifiers: [], keyCode: 121 });
    expect(parseKeyChord('Ctrl Tab')).toEqual({ modifiers: ['control'], keyCode: 48 });
  });

  it('rejects modifier-only and unknown keys', () => {
    expect(parseKeyChord('cmd+shift')).toBeNull();
    expect(parseKeyChord('cmd+launchrocket')).toBeNull();
    expect(parseKeyChord('')).toBeNull();
  });
});

describe('chordToOsascriptArgs', () => {
  it('passes characters through argv instead of interpolating them', () => {
    const args = chordToOsascriptArgs({ modifiers: ['command'], character: '"' });
    expect(actionLine(args)).toBe('keystroke (item 1 of argv) using {command down}');
    expect(args.slice(-2)).toEqual(['--', '"']);
  });

  it('uses key codes and clamps repeats', () => {
    const args = chordToOsascriptArgs({ modifiers: [], keyCode: 125 }, 500);
    expect(args).toContain('repeat 20 times');
    expect(actionLine(args)).toBe('key code 125');
    expect(args).not.toContain('--');
  });
});

describe('chordNeedsConfirmation', () => {
  it('flags closing, quitting, deleting, and sending', () => {
    expect(chordNeedsConfirmation(parseKeyChord('cmd+w')!)).toBe(true);
    expect(chordNeedsConfirmation(parseKeyChord('cmd+q')!)).toBe(true);
    expect(chordNeedsConfirmation(parseKeyChord('cmd+delete')!)).toBe(true);
    expect(chordNeedsConfirmation(parseKeyChord('enter')!)).toBe(true);
  });

  it('allows navigation shortcuts', () => {
    expect(chordNeedsConfirmation(parseKeyChord('cmd+t')!)).toBe(false);
    expect(chordNeedsConfirmation(parseKeyChord('escape')!)).toBe(false);
    expect(chordNeedsConfirmation(parseKeyChord('delete')!)).toBe(false);
  });
});

describe('resolveInstalledApp', () => {
  it('matches exact names, aliases, and prefixes', () => {
    expect(resolveInstalledApp('slack', APPS)).toBe('/Applications/Slack.app');
    expect(resolveInstalledApp('Chrome', APPS)).toBe('/Applications/Google Chrome.app');
    expect(resolveInstalledApp('VS Code', APPS)).toBe('/Applications/Visual Studio Code.app');
    expect(resolveInstalledApp('settings', APPS)).toBe('/System/Applications/System Settings.app');
  });

  it('returns null for unknown apps', () => {
    expect(resolveInstalledApp('Photoshop', APPS)).toBeNull();
    expect(resolveInstalledApp('  ', APPS)).toBeNull();
  });
});

describe('runVoiceAction', () => {
  it('scrolls a page with Page Down and to the bottom with Cmd+Down', async () => {
    const d = deps();
    await expect(runVoiceAction('scroll', { direction: 'down' }, d)).resolves.toMatchObject({
      ok: true,
    });
    expect(actionLine(d.runOsascript.mock.calls[0][0])).toBe('key code 121');
    await runVoiceAction('scroll', { direction: 'bottom' }, d);
    expect(actionLine(d.runOsascript.mock.calls[1][0])).toBe('key code 125 using {command down}');
  });

  it('switches tabs with Ctrl+Tab and Cmd+number', async () => {
    const d = deps();
    await runVoiceAction('switch_tab', { target: 'next' }, d);
    expect(actionLine(d.runOsascript.mock.calls[0][0])).toBe('key code 48 using {control down}');
    await runVoiceAction('switch_tab', { target: 'number', number: 3 }, d);
    expect(d.runOsascript.mock.calls[1][0].slice(-1)).toEqual(['3']);
    await expect(
      runVoiceAction('switch_tab', { target: 'number', number: 12 }, d)
    ).resolves.toMatchObject({ ok: false });
  });

  it('opens installed apps and rejects unknown ones', async () => {
    const d = deps();
    await expect(runVoiceAction('open_app', { name: 'slack' }, d)).resolves.toEqual({
      ok: true,
      message: 'Opened Slack.',
    });
    expect(d.openApp).toHaveBeenCalledWith('/Applications/Slack.app');
    await expect(runVoiceAction('open_app', { name: 'Photoshop' }, d)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('asks for confirmation before destructive keys and runs them once confirmed', async () => {
    const d = deps();
    const first = await runVoiceAction('press_keys', { keys: 'cmd+w' }, d);
    expect(first).toMatchObject({ ok: false, needsConfirmation: true });
    expect(d.runOsascript).not.toHaveBeenCalled();
    await expect(
      runVoiceAction('press_keys', { keys: 'cmd+w', confirmed: true }, d)
    ).resolves.toMatchObject({ ok: true });
    expect(d.runOsascript).toHaveBeenCalledTimes(1);
  });

  it('types without confirmation but needs it to submit', async () => {
    const d = deps();
    await expect(runVoiceAction('type_text', { text: 'hello team' }, d)).resolves.toEqual({
      ok: true,
      message: 'Typed.',
    });
    expect(d.pasteText).toHaveBeenCalledWith('hello team');
    await expect(
      runVoiceAction('type_text', { text: 'ship it', submit: true }, d)
    ).resolves.toMatchObject({ needsConfirmation: true });
    await expect(
      runVoiceAction('type_text', { text: 'ship it', submit: true, confirmed: true }, d)
    ).resolves.toEqual({ ok: true, message: 'Typed and sent.' });
    expect(actionLine(d.runOsascript.mock.calls[0][0])).toBe('key code 36');
  });

  it('reports missing Accessibility permission instead of pressing keys', async () => {
    const d = deps({ trusted: false });
    const result = await runVoiceAction('scroll', { direction: 'up' }, d);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Accessibility/);
    expect(d.runOsascript).not.toHaveBeenCalled();
  });

  it('turns thrown errors into a failed result', async () => {
    const d = deps({ osascriptError: new Error('boom') });
    await expect(runVoiceAction('press_keys', { keys: 'cmd+t' }, d)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('boom'),
    });
  });

  it('rejects unknown actions', async () => {
    await expect(runVoiceAction('rm_rf', {}, deps())).resolves.toMatchObject({ ok: false });
  });
});
