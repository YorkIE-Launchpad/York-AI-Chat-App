/**
 * The fixed set of Mac actions voice control may run. The model can only call
 * these tools; arguments are validated and mapped onto System Events key codes
 * or `open -a`, never onto free-form scripts or shell commands.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { systemPreferences } from 'electron';
import type { VoiceActionName, VoiceActionResult } from '../../shared/voice-control';
import { defaultRunOsascript, type RunOsascript } from '../snap/front-app';
import { pasteText as defaultPasteText, type PasteResult } from '../snap/paste-into-app';

const OPEN_PATH = '/usr/bin/open';

export interface VoiceActionDeps {
  runOsascript?: RunOsascript;
  openApp?: (appPath: string) => Promise<void>;
  listApps?: () => string[];
  pasteText?: (text: string) => Promise<PasteResult>;
  isTrusted?: (prompt: boolean) => boolean;
}

type Modifier = 'command' | 'shift' | 'option' | 'control';

interface KeyChord {
  modifiers: Modifier[];
  /** Exactly one of keyCode / character is set. */
  keyCode?: number;
  character?: string;
}

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: 'command',
  command: 'command',
  meta: 'command',
  shift: 'shift',
  alt: 'option',
  opt: 'option',
  option: 'option',
  ctrl: 'control',
  control: 'control',
};

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  forwarddelete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

const SCROLL_REPEAT_SMALL = 5;

function modifierClause(modifiers: Modifier[]): string {
  if (modifiers.length === 0) return '';
  return ` using {${modifiers.map((m) => `${m} down`).join(', ')}}`;
}

/** osascript args; the character travels as argv so it never needs escaping. */
export function chordToOsascriptArgs(chord: KeyChord, repeat = 1): string[] {
  const times = Math.max(1, Math.min(20, Math.round(repeat)));
  const action =
    chord.keyCode !== undefined
      ? `key code ${chord.keyCode}${modifierClause(chord.modifiers)}`
      : `keystroke (item 1 of argv)${modifierClause(chord.modifiers)}`;
  const args = [
    '-e',
    'on run argv',
    '-e',
    'tell application "System Events"',
    '-e',
    `repeat ${times} times`,
    '-e',
    action,
    '-e',
    'end repeat',
    '-e',
    'end tell',
    '-e',
    'end run',
  ];
  if (chord.character !== undefined) args.push('--', chord.character);
  return args;
}

/** Parses "cmd+shift+t", "escape", "Cmd F". Returns null for anything unrecognised. */
export function parseKeyChord(raw: string): KeyChord | null {
  const parts = raw
    .toLowerCase()
    .split(/[+\s-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const modifiers: Modifier[] = [];
  const keyParts: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
    } else {
      keyParts.push(part);
    }
  }
  if (keyParts.length === 0) return null;
  // "page down" arrives as two words; join them back into one key name.
  const key = keyParts.join('');
  const normalized = key.replace(/[^a-z0-9]/g, '') || key;
  if (KEY_CODES[normalized] !== undefined) {
    return { modifiers, keyCode: KEY_CODES[normalized] };
  }
  if ([...key].length === 1) return { modifiers, character: key };
  return null;
}

/** Closing, quitting, deleting, and sending are only run after a spoken "confirm". */
export function chordNeedsConfirmation(chord: KeyChord): boolean {
  const hasCommand = chord.modifiers.includes('command');
  if (chord.keyCode === KEY_CODES.return) return true;
  if (chord.keyCode === KEY_CODES.delete || chord.keyCode === KEY_CODES.forwarddelete) {
    return hasCommand;
  }
  if (hasCommand && chord.character && ['w', 'q', 'x'].includes(chord.character)) return true;
  return false;
}

const APP_DIRECTORIES = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  join(os.homedir(), 'Applications'),
];

const APP_ALIASES: Record<string, string> = {
  chrome: 'googlechrome',
  vscode: 'visualstudiocode',
  code: 'visualstudiocode',
  teams: 'microsoftteams',
  outlook: 'microsoftoutlook',
  word: 'microsoftword',
  excel: 'microsoftexcel',
  powerpoint: 'microsoftpowerpoint',
  settings: 'systemsettings',
  preferences: 'systemsettings',
  iterm: 'iterm2',
};

export function defaultListApps(): string[] {
  const found: string[] = [];
  for (const dir of APP_DIRECTORIES) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.app')) found.push(join(dir, entry));
      }
    } catch {
      // Directory may not exist (e.g. ~/Applications).
    }
  }
  found.push('/System/Library/CoreServices/Finder.app');
  return found;
}

function normalizeAppName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.app$/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Exact name, then alias, then prefix, then substring match against installed apps. */
export function resolveInstalledApp(spoken: string, apps: string[]): string | null {
  const wanted = normalizeAppName(spoken);
  if (!wanted) return null;
  const target = APP_ALIASES[wanted] ?? wanted;
  const entries = apps.map((appPath) => ({
    appPath,
    key: normalizeAppName(appPath.split('/').pop() ?? ''),
  }));
  return (
    entries.find((e) => e.key === target)?.appPath ??
    entries.find((e) => e.key.startsWith(target))?.appPath ??
    entries.find((e) => e.key.includes(target))?.appPath ??
    null
  );
}

const defaultOpenApp = (appPath: string) =>
  new Promise<void>((resolve, reject) => {
    execFile(OPEN_PATH, ['-a', appPath], { timeout: 8000 }, (error) =>
      error ? reject(error) : resolve()
    );
  });

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const ACCESSIBILITY_MESSAGE =
  'Accessibility permission is off. Ask the user to allow York GrowthOS in System Settings, Privacy & Security, Accessibility.';

export async function runVoiceAction(
  name: VoiceActionName | string,
  rawArgs: unknown,
  deps: VoiceActionDeps = {}
): Promise<VoiceActionResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const run = deps.runOsascript ?? defaultRunOsascript;
  const isTrusted =
    deps.isTrusted ?? ((prompt: boolean) => systemPreferences.isTrustedAccessibilityClient(prompt));
  const press = async (chord: KeyChord, repeat = 1): Promise<VoiceActionResult | null> => {
    if (!isTrusted(true)) return { ok: false, message: ACCESSIBILITY_MESSAGE };
    await run(chordToOsascriptArgs(chord, repeat));
    return null;
  };

  try {
    switch (name) {
      case 'scroll': {
        const direction = str(args.direction);
        const amount = str(args.amount) === 'small' ? 'small' : 'page';
        const chord: Record<string, { chord: KeyChord; repeat: number }> = {
          up:
            amount === 'small'
              ? { chord: { modifiers: [], keyCode: KEY_CODES.up }, repeat: SCROLL_REPEAT_SMALL }
              : { chord: { modifiers: [], keyCode: KEY_CODES.pageup }, repeat: 1 },
          down:
            amount === 'small'
              ? { chord: { modifiers: [], keyCode: KEY_CODES.down }, repeat: SCROLL_REPEAT_SMALL }
              : { chord: { modifiers: [], keyCode: KEY_CODES.pagedown }, repeat: 1 },
          top: { chord: { modifiers: ['command'], keyCode: KEY_CODES.up }, repeat: 1 },
          bottom: { chord: { modifiers: ['command'], keyCode: KEY_CODES.down }, repeat: 1 },
        };
        const step = chord[direction];
        if (!step) return { ok: false, message: `Unknown scroll direction "${direction}".` };
        return (
          (await press(step.chord, step.repeat)) ?? { ok: true, message: `Scrolled ${direction}.` }
        );
      }

      case 'switch_tab': {
        const target = str(args.target);
        if (target === 'next') {
          return (
            (await press({ modifiers: ['control'], keyCode: KEY_CODES.tab })) ?? {
              ok: true,
              message: 'Next tab.',
            }
          );
        }
        if (target === 'previous') {
          return (
            (await press({ modifiers: ['control', 'shift'], keyCode: KEY_CODES.tab })) ?? {
              ok: true,
              message: 'Previous tab.',
            }
          );
        }
        const index = Number(args.number);
        if (target === 'number' && Number.isInteger(index) && index >= 1 && index <= 9) {
          return (
            (await press({ modifiers: ['command'], character: String(index) })) ?? {
              ok: true,
              message: `Tab ${index}.`,
            }
          );
        }
        return { ok: false, message: 'Say next tab, previous tab, or a tab number from 1 to 9.' };
      }

      case 'open_app':
      case 'focus_app': {
        const spoken = str(args.name).trim();
        const appPath = resolveInstalledApp(spoken, (deps.listApps ?? defaultListApps)());
        if (!appPath) return { ok: false, message: `No installed app matches "${spoken}".` };
        await (deps.openApp ?? defaultOpenApp)(appPath);
        const label =
          appPath
            .split('/')
            .pop()
            ?.replace(/\.app$/, '') ?? spoken;
        return { ok: true, message: `Opened ${label}.` };
      }

      case 'press_keys': {
        const chord = parseKeyChord(str(args.keys));
        if (!chord)
          return { ok: false, message: `Could not understand the keys "${str(args.keys)}".` };
        if (chordNeedsConfirmation(chord) && args.confirmed !== true) {
          return {
            ok: false,
            needsConfirmation: true,
            message: `Pressing ${str(args.keys)} can close, delete, or send something. Ask the user to say "confirm".`,
          };
        }
        return (await press(chord)) ?? { ok: true, message: `Pressed ${str(args.keys)}.` };
      }

      case 'type_text': {
        const text = str(args.text);
        if (!text) return { ok: false, message: 'Nothing to type.' };
        const submit = args.submit === true;
        if (submit && args.confirmed !== true) {
          return {
            ok: false,
            needsConfirmation: true,
            message: 'Typing and pressing Enter will send it. Ask the user to say "confirm".',
          };
        }
        const pasted = await (deps.pasteText ?? defaultPasteText)(text);
        if (!pasted.success) {
          return pasted.reason === 'accessibility'
            ? { ok: false, message: ACCESSIBILITY_MESSAGE }
            : {
                ok: false,
                message: 'Could not type into the focused field. The text is on the clipboard.',
              };
        }
        if (submit) {
          const blocked = await press({ modifiers: [], keyCode: KEY_CODES.return });
          if (blocked) return blocked;
        }
        return { ok: true, message: submit ? 'Typed and sent.' : 'Typed.' };
      }

      case 'stop_listening':
        return { ok: true, message: 'Stopping.' };

      default:
        return { ok: false, message: `Unknown action "${name}".` };
    }
  } catch (error) {
    return {
      ok: false,
      message: `The action failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
