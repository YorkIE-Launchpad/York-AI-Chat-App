import { describe, expect, it } from 'vitest';
import {
  formatAccelerator,
  keyEventToAccelerator,
  type ShortcutKeyEvent,
} from '../../renderer/utils/shortcut-accelerator';
import { canonicalAccelerator, validateScreenSnapAccelerator } from '../../shared/screen-snap';

function keyEvent(code: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe('keyEventToAccelerator', () => {
  it('maps modifiers and letter keys by physical code', () => {
    expect(keyEventToAccelerator(keyEvent('KeyG', { metaKey: true, shiftKey: true }))).toBe(
      'Shift+Command+G'
    );
    expect(keyEventToAccelerator(keyEvent('KeyS', { ctrlKey: true, altKey: true }))).toBe(
      'Control+Option+S'
    );
  });

  it('maps digits, function keys, and named keys', () => {
    expect(keyEventToAccelerator(keyEvent('Digit2', { metaKey: true }))).toBe('Command+2');
    expect(keyEventToAccelerator(keyEvent('F5', { altKey: true }))).toBe('Option+F5');
    expect(keyEventToAccelerator(keyEvent('Space', { ctrlKey: true }))).toBe('Control+Space');
    expect(keyEventToAccelerator(keyEvent('ArrowUp', { metaKey: true }))).toBe('Command+Up');
  });

  it('ignores modifier-only presses and presses without modifiers', () => {
    expect(keyEventToAccelerator(keyEvent('MetaLeft', { metaKey: true }))).toBeNull();
    expect(keyEventToAccelerator(keyEvent('ShiftLeft', { shiftKey: true }))).toBeNull();
    expect(keyEventToAccelerator(keyEvent('KeyG'))).toBeNull();
  });
});

describe('formatAccelerator', () => {
  it('renders mac glyphs in standard order', () => {
    expect(formatAccelerator('CommandOrControl+Shift+G')).toBe('⇧⌘G');
    expect(formatAccelerator('Shift+Command+G')).toBe('⇧⌘G');
    expect(formatAccelerator('Control+Option+Up')).toBe('⌃⌥↑');
  });

  it('returns empty string for missing shortcuts', () => {
    expect(formatAccelerator(null)).toBe('');
    expect(formatAccelerator(undefined)).toBe('');
  });
});

describe('validateScreenSnapAccelerator', () => {
  it('accepts combos with a non-Shift modifier', () => {
    expect(validateScreenSnapAccelerator('CommandOrControl+Shift+G')).toEqual({ ok: true });
    expect(validateScreenSnapAccelerator('Control+Option+S')).toEqual({ ok: true });
    expect(validateScreenSnapAccelerator('Command+Option+Shift+4')).toEqual({ ok: true });
  });

  it('rejects macOS screenshot and Ask Growth OS combos', () => {
    expect(validateScreenSnapAccelerator('Command+Shift+5')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    expect(validateScreenSnapAccelerator('Shift+Command+Space')).toEqual({
      ok: false,
      reason: 'reserved',
    });
  });

  it('rejects malformed combos', () => {
    expect(validateScreenSnapAccelerator('Shift+A')).toEqual({ ok: false, reason: 'invalid' });
    expect(validateScreenSnapAccelerator('Command+A+B')).toEqual({ ok: false, reason: 'invalid' });
    expect(validateScreenSnapAccelerator('')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('canonicalizes alias spellings', () => {
    expect(canonicalAccelerator('CmdOrCtrl+Shift+g')).toBe(canonicalAccelerator('Shift+Command+G'));
  });
});
