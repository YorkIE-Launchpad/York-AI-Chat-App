import type { QuestionItem } from '../../types';

/** Option labels that imply the user should type a custom value (e.g. "Enter topic"). */
const CUSTOM_INPUT_OPTION_PATTERN = /^(enter|type|specify|custom|other|provide)\b/i;

export function isCustomInputOption(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return false;
  return CUSTOM_INPUT_OPTION_PATTERN.test(trimmed);
}

export function isQuestionAnswered(
  q: QuestionItem,
  idx: number,
  selections: Record<number, string[]>,
  freeText: Record<number, string>,
  customText: Record<number, string>
): boolean {
  if (q.options && q.options.length > 0) {
    const selected = (selections[idx] || [])[0];
    if (!selected) return false;
    if (isCustomInputOption(selected)) {
      return (customText[idx] || '').trim().length > 0;
    }
    return true;
  }
  return (freeText[idx] || '').trim().length > 0;
}

export function buildAskUserQuestionAnswers(
  questions: QuestionItem[],
  selections: Record<number, string[]>,
  freeText: Record<number, string>,
  customText: Record<number, string>
): Record<number, string[]> {
  const answers: Record<number, string[]> = { ...selections };
  questions.forEach((q, idx) => {
    if (q.options && q.options.length > 0) {
      const selected = (selections[idx] || [])[0];
      if (selected && isCustomInputOption(selected)) {
        const text = (customText[idx] || '').trim();
        if (text) {
          answers[idx] = [text];
        }
      }
    } else {
      const text = (freeText[idx] || '').trim();
      if (text) {
        answers[idx] = [text];
      }
    }
  });
  return answers;
}
