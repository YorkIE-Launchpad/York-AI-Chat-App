/**
 * Composer skill triggers: `/skill` and `@skill` (mention) detection.
 * Shared between React hooks and unit tests — no React deps.
 */

export type SkillTriggerMode = 'slash' | 'at';

export interface SkillComposerTrigger {
  mode: SkillTriggerMode;
  /** Inclusive start index of the trigger token (the `/` or `@`). */
  start: number;
  /** Exclusive end index (usually the caret). */
  end: number;
  /** Query after the trigger character (lowercased). */
  query: string;
}

/**
 * Detect an active skill autocomplete token ending at `cursor`.
 *
 * - `@name` mentions: any `@token` after start/whitespace/(
 * - `/name` commands: whole-line slash (legacy) without trailing args space,
 *   or a mid-line `/token` without spaces yet
 */
export function getSkillComposerTrigger(
  value: string,
  cursor: number
): SkillComposerTrigger | null {
  if (cursor < 0 || cursor > value.length) return null;
  const before = value.slice(0, cursor);

  // @mention — e.g. "please use @pdf" or standalone "@yor"
  const atMatch = before.match(/(?:^|[\s([{])(@)([a-zA-Z0-9-]*)$/);
  if (atMatch) {
    const token = atMatch[1] + atMatch[2];
    return {
      mode: 'at',
      start: cursor - token.length,
      end: cursor,
      query: atMatch[2].toLowerCase(),
    };
  }

  // Whole-prompt slash command (original / loop / skill UX)
  if (/^\/[^\n]*$/.test(value)) {
    // Close once the user has `/name ` so they can type args freely
    if (/^\/\S+\s/.test(value)) {
      return null;
    }
    return {
      mode: 'slash',
      start: 0,
      end: cursor,
      query: value.slice(1, cursor).toLowerCase(),
    };
  }

  // Mid-line `/token` (single token, no spaces yet)
  const slashMatch = before.match(/(?:^|[\s([{])(\/)([a-zA-Z0-9-]*)$/);
  if (slashMatch) {
    const token = slashMatch[1] + slashMatch[2];
    return {
      mode: 'slash',
      start: cursor - token.length,
      end: cursor,
      query: slashMatch[2].toLowerCase(),
    };
  }

  return null;
}

/** Replace the active trigger range with the chosen skill text. */
export function applySkillTriggerSelection(
  value: string,
  trigger: SkillComposerTrigger | null,
  insertText: string,
  cursorFallback = value.length
): { next: string; cursor: number } {
  if (trigger) {
    const next = value.slice(0, trigger.start) + insertText + value.slice(trigger.end);
    return { next, cursor: trigger.start + insertText.length };
  }
  const insertAt = Math.max(0, Math.min(cursorFallback, value.length));
  let piece = insertText;
  if (insertAt > 0 && !/\s/.test(value[insertAt - 1]!) && !insertText.startsWith(' ')) {
    piece = ` ${insertText}`;
  }
  const next = value.slice(0, insertAt) + piece + value.slice(insertAt);
  return { next, cursor: insertAt + piece.length };
}
