/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { insertTextAtCaret, isVoiceInsertTarget } from '../../renderer/voice-buttons/insert-text';

describe('insertTextAtCaret', () => {
  it('inserts into a textarea and ignores the voice widget', () => {
    document.body.innerHTML = `
      <textarea id="field">Hello </textarea>
      <div data-voice-widget><textarea id="widget"></textarea></div>
    `;
    const field = document.getElementById('field') as HTMLTextAreaElement;
    field.selectionStart = field.value.length;
    field.selectionEnd = field.value.length;
    expect(insertTextAtCaret(field, 'there')).toBe(true);
    expect(field.value).toBe('Hello there');

    const widget = document.getElementById('widget') as HTMLTextAreaElement;
    expect(isVoiceInsertTarget(widget)).toBe(false);
    expect(insertTextAtCaret(widget, 'nope')).toBe(false);
  });
});
