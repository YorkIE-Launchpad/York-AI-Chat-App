import { parseAccelerator } from '../../shared/screen-snap';

export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'
>;

const NAMED_CODES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const KEY_GLYPHS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
};

const MODIFIER_GLYPHS: Record<string, string> = {
  Control: '⌃',
  Option: '⌥',
  Shift: '⇧',
  Command: '⌘',
};

/** Map a physical key code to an Electron accelerator key, or null for modifiers/unsupported keys. */
function codeToAcceleratorKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_CODES[code] ?? null;
}

/**
 * Convert a keydown into an Electron accelerator (e.g. `Command+Shift+G`).
 * Uses `event.code` so Option+letter is not altered by the keyboard layout.
 * Returns null for modifier-only presses or when no modifier is held.
 */
export function keyEventToAccelerator(event: ShortcutKeyEvent): string | null {
  const key = codeToAcceleratorKey(event.code);
  if (!key) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Option');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Command');
  if (modifiers.length === 0) return null;

  return [...modifiers, key].join('+');
}

/** Render an accelerator with macOS glyphs, e.g. `CommandOrControl+Shift+G` -> `⌘⇧G`. */
export function formatAccelerator(accelerator: string | null | undefined): string {
  if (!accelerator) return '';
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return accelerator;
  const modifiers = parsed.modifiers.map((m) => MODIFIER_GLYPHS[m] ?? m).join('');
  return `${modifiers}${KEY_GLYPHS[parsed.key] ?? parsed.key}`;
}
