const WIDGET_SELECTOR = '[data-voice-widget]';

export function isVoiceInsertTarget(node: EventTarget | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  if (node.closest(WIDGET_SELECTOR)) return false;
  if (node instanceof HTMLInputElement) {
    const blocked = node.type === 'password' || node.type === 'file' || node.type === 'checkbox';
    return !blocked && !node.readOnly && !node.disabled;
  }
  if (node instanceof HTMLTextAreaElement) {
    return !node.readOnly && !node.disabled;
  }
  return node.isContentEditable;
}

/**
 * Insert text at the caret. Uses the browser undo stack when it can,
 * then a React-friendly value setter if the field did not change.
 */
export function insertTextAtCaret(el: HTMLElement, text: string): boolean {
  if (!text || !isVoiceInsertTarget(el)) return false;
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const before = el.value;
    const start = el.selectionStart ?? before.length;
    const end = el.selectionEnd ?? start;
    const commanded =
      typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    if (commanded && el.value !== before) return true;

    const next = before.slice(0, start) + text + before.slice(end);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    setter?.call(el, next);
    const caret = start + text.length;
    try {
      el.selectionStart = caret;
      el.selectionEnd = caret;
    } catch {
      // Some input types reject a selection.
    }
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })
    );
    return el.value === next;
  }

  if (el.isContentEditable && typeof document.execCommand === 'function') {
    return document.execCommand('insertText', false, text);
  }
  return false;
}

export async function copyVoiceText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
