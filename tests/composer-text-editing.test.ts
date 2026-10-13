import { describe, expect, it } from 'vitest';
import {
  getComposerTextEdit,
  type ComposerKeyInput,
  type ComposerTextEdit,
} from '../src/renderer/utils/composer-text-editing';

const key = (k: string, mods: Partial<ComposerKeyInput> = {}): ComposerKeyInput => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

function apply(value: string, edit: ComposerTextEdit | null) {
  if (!edit) return null;
  return {
    value: value.slice(0, edit.replaceStart) + edit.text + value.slice(edit.replaceEnd),
    selection: [edit.selectionStart, edit.selectionEnd],
  };
}

const shiftEnter = key('Enter', { shiftKey: true });

describe('composer list continuation', () => {
  it('continues a numbered list with the next number', () => {
    const value = '1. first';
    expect(apply(value, getComposerTextEdit(shiftEnter, value, 8, 8))).toEqual({
      value: '1. first\n2. ',
      selection: [12, 12],
    });
  });

  it('continues bullets, nested indentation and checkboxes', () => {
    const value = '  - [x] done';
    expect(
      apply(value, getComposerTextEdit(shiftEnter, value, value.length, value.length))?.value
    ).toBe('  - [x] done\n  - [ ] ');
  });

  it('continues the list from the middle of the line', () => {
    const value = '3) ab';
    expect(apply(value, getComposerTextEdit(shiftEnter, value, 4, 4))?.value).toBe('3) a\n4) b');
  });

  it('clears the marker on an empty list item', () => {
    const value = '1. one\n2. ';
    expect(
      apply(value, getComposerTextEdit(shiftEnter, value, value.length, value.length))
    ).toEqual({
      value: '1. one\n',
      selection: [7, 7],
    });
  });

  it('leaves non-list lines and plain Enter alone', () => {
    expect(getComposerTextEdit(shiftEnter, 'hello', 5, 5)).toBeNull();
    expect(getComposerTextEdit(key('Enter'), '1. a', 4, 4)).toBeNull();
  });
});

describe('composer list indentation', () => {
  it('indents and outdents list items with Tab / Shift+Tab', () => {
    const value = '- a\n- b';
    const indented = apply(value, getComposerTextEdit(key('Tab'), value, 7, 7));
    expect(indented).toEqual({ value: '- a\n  - b', selection: [9, 9] });
    const outdented = apply(
      indented!.value,
      getComposerTextEdit(key('Tab', { shiftKey: true }), indented!.value, 9, 9)
    );
    expect(outdented).toEqual({ value, selection: [7, 7] });
  });

  it('indents every selected list line', () => {
    const value = '1. a\n2. b';
    expect(apply(value, getComposerTextEdit(key('Tab'), value, 0, value.length))?.value).toBe(
      '  1. a\n  2. b'
    );
  });

  it('keeps default Tab behaviour outside lists', () => {
    expect(getComposerTextEdit(key('Tab'), 'plain text', 3, 3)).toBeNull();
    expect(getComposerTextEdit(key('Tab', { shiftKey: true }), '- a', 3, 3)).toBeNull();
  });
});

describe('composer inline formatting', () => {
  it('wraps the selection in bold, italic, code and strikethrough', () => {
    const value = 'say hi';
    expect(apply(value, getComposerTextEdit(key('b', { metaKey: true }), value, 4, 6))).toEqual({
      value: 'say **hi**',
      selection: [6, 8],
    });
    expect(apply(value, getComposerTextEdit(key('i', { ctrlKey: true }), value, 4, 6))?.value).toBe(
      'say *hi*'
    );
    expect(apply(value, getComposerTextEdit(key('e', { metaKey: true }), value, 4, 6))?.value).toBe(
      'say `hi`'
    );
    expect(
      apply(value, getComposerTextEdit(key('x', { metaKey: true, shiftKey: true }), value, 4, 6))
        ?.value
    ).toBe('say ~~hi~~');
  });

  it('inserts an empty pair with the caret inside when nothing is selected', () => {
    expect(apply('', getComposerTextEdit(key('b', { metaKey: true }), '', 0, 0))).toEqual({
      value: '****',
      selection: [2, 2],
    });
  });

  it('toggles formatting off when already wrapped', () => {
    const value = 'say **hi**';
    expect(apply(value, getComposerTextEdit(key('b', { metaKey: true }), value, 6, 8))).toEqual({
      value: 'say hi',
      selection: [4, 6],
    });
    expect(apply(value, getComposerTextEdit(key('b', { metaKey: true }), value, 4, 10))).toEqual({
      value: 'say hi',
      selection: [4, 6],
    });
  });
});
