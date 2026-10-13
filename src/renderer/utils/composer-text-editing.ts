export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface ComposerTextEdit {
  replaceStart: number;
  replaceEnd: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const INDENT = '  ';
const LIST_ITEM_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const WRAP_SHORTCUTS: Record<string, string> = { b: '**', i: '*', e: '`' };

interface ListItem {
  indent: string;
  bullet: string | null;
  number: number | null;
  delimiter: string;
  spacing: string;
  hasCheckbox: boolean;
  markerLength: number;
}

function parseListItem(line: string): ListItem | null {
  const match = LIST_ITEM_RE.exec(line);
  if (!match) return null;
  return {
    indent: match[1],
    bullet: match[2] ?? null,
    number: match[3] !== undefined ? Number(match[3]) : null,
    delimiter: match[4] ?? '',
    spacing: match[5],
    hasCheckbox: Boolean(match[6]),
    markerLength: match[0].length,
  };
}

function lineBounds(value: string, index: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', index - 1) + 1;
  const newline = value.indexOf('\n', index);
  return { start, end: newline === -1 ? value.length : newline };
}

function nextMarker(item: ListItem): string {
  const head = item.number !== null ? `${item.number + 1}${item.delimiter}` : item.bullet;
  return `${item.indent}${head}${item.spacing}${item.hasCheckbox ? '[ ] ' : ''}`;
}

function continueList(value: string, start: number, end: number): ComposerTextEdit | null {
  if (start !== end) return null;
  const line = lineBounds(value, start);
  const item = parseListItem(value.slice(line.start, line.end));
  if (!item || start < line.start + item.markerLength) return null;

  if (line.start + item.markerLength === line.end) {
    return {
      replaceStart: line.start,
      replaceEnd: line.end,
      text: '',
      selectionStart: line.start,
      selectionEnd: line.start,
    };
  }

  const insert = `\n${nextMarker(item)}`;
  const caret = start + insert.length;
  return {
    replaceStart: start,
    replaceEnd: start,
    text: insert,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

function shiftIndent(
  value: string,
  start: number,
  end: number,
  outdent: boolean
): ComposerTextEdit | null {
  const blockStart = lineBounds(value, start).start;
  const lastLineAnchor = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const blockEnd = lineBounds(value, lastLineAnchor).end;
  const lines = value.slice(blockStart, blockEnd).split('\n');
  if (!lines.every((line) => parseListItem(line) || line.trim() === '')) return null;
  if (!lines.some((line) => parseListItem(line))) return null;

  let firstDelta = 0;
  let totalDelta = 0;
  const next = lines.map((line, i) => {
    let updated = line;
    if (outdent) {
      const removable = /^( {1,2}|\t)/.exec(line)?.[0] ?? '';
      updated = line.slice(removable.length);
    } else if (line.trim() !== '') {
      updated = INDENT + line;
    }
    const delta = updated.length - line.length;
    if (i === 0) firstDelta = delta;
    totalDelta += delta;
    return updated;
  });
  if (totalDelta === 0) return null;

  const nextStart = Math.max(blockStart, start + firstDelta);
  return {
    replaceStart: blockStart,
    replaceEnd: blockEnd,
    text: next.join('\n'),
    selectionStart: nextStart,
    selectionEnd: start === end ? nextStart : Math.max(nextStart, end + totalDelta),
  };
}

function toggleWrap(value: string, start: number, end: number, marker: string): ComposerTextEdit {
  const n = marker.length;
  const selected = value.slice(start, end);
  const wrappedOutside =
    value.slice(start - n, start) === marker && value.slice(end, end + n) === marker;
  if (wrappedOutside && start - n >= 0) {
    return {
      replaceStart: start - n,
      replaceEnd: end + n,
      text: selected,
      selectionStart: start - n,
      selectionEnd: end - n,
    };
  }
  const wrappedInside =
    selected.length >= n * 2 && selected.startsWith(marker) && selected.endsWith(marker);
  if (wrappedInside) {
    const inner = selected.slice(n, selected.length - n);
    return {
      replaceStart: start,
      replaceEnd: end,
      text: inner,
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }
  return {
    replaceStart: start,
    replaceEnd: end,
    text: `${marker}${selected}${marker}`,
    selectionStart: start + n,
    selectionEnd: end + n,
  };
}

/**
 * Markdown editing helpers for the plain-text chat composer. Returns null when
 * the key should keep its default behaviour (plain Enter is handled by the
 * caller as "send").
 */
export function getComposerTextEdit(
  event: ComposerKeyInput,
  value: string,
  selectionStart: number,
  selectionEnd: number
): ComposerTextEdit | null {
  const mod = event.metaKey || event.ctrlKey;

  if (event.key === 'Enter' && event.shiftKey && !mod && !event.altKey) {
    return continueList(value, selectionStart, selectionEnd);
  }

  if (event.key === 'Tab' && !mod && !event.altKey) {
    return shiftIndent(value, selectionStart, selectionEnd, event.shiftKey);
  }

  if (mod && !event.altKey && !event.shiftKey) {
    const marker = WRAP_SHORTCUTS[event.key.toLowerCase()];
    if (marker) return toggleWrap(value, selectionStart, selectionEnd, marker);
  }

  if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'x') {
    return toggleWrap(value, selectionStart, selectionEnd, '~~');
  }

  return null;
}

/**
 * Applies an edit through the browser's editing pipeline so native undo/redo
 * keeps working and React's onChange fires.
 */
export function applyComposerTextEdit(textarea: HTMLTextAreaElement, edit: ComposerTextEdit): void {
  textarea.focus();
  textarea.setSelectionRange(edit.replaceStart, edit.replaceEnd);
  const inserted =
    edit.text === ''
      ? document.execCommand('delete')
      : document.execCommand('insertText', false, edit.text);
  if (!inserted) {
    textarea.setRangeText(edit.text, edit.replaceStart, edit.replaceEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

export function handleComposerTextKeyDown(
  event: ComposerKeyInput & { preventDefault: () => void },
  textarea: HTMLTextAreaElement | null
): boolean {
  if (!textarea) return false;
  const edit = getComposerTextEdit(
    event,
    textarea.value,
    textarea.selectionStart ?? textarea.value.length,
    textarea.selectionEnd ?? textarea.value.length
  );
  if (!edit) return false;
  event.preventDefault();
  applyComposerTextEdit(textarea, edit);
  return true;
}
