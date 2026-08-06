export { DEFAULT_SESSION_TITLE, getDefaultTitleFromPrompt } from '../../shared/session-title';
import { DEFAULT_SESSION_TITLE, getDefaultTitleFromPrompt } from '../../shared/session-title';

export type TitleDecisionInput = {
  userMessageCount: number;
  currentTitle: string;
  prompt: string;
  hasAttempted: boolean;
};

/** Han, Hiragana, Katakana, Hangul, and common CJK extension blocks. */
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function countScriptChars(text: string): { cjk: number; otherLetter: number } {
  let cjk = 0;
  let otherLetter = 0;
  for (const ch of text) {
    if (CJK_CHAR_RE.test(ch)) {
      cjk += 1;
    } else if (/\p{L}/u.test(ch)) {
      otherLetter += 1;
    }
  }
  return { cjk, otherLetter };
}

/** True if the text contains any CJK (Han / Kana / Hangul) character. */
export function hasCjkText(text: string): boolean {
  for (const ch of text) {
    if (CJK_CHAR_RE.test(ch)) return true;
  }
  return false;
}

/**
 * True when the text is primarily written in a CJK script (enough for language matching).
 * Latin-dominant mixed strings (e.g. English with a product name) return false.
 */
export function isPrimarilyCjkText(text: string): boolean {
  const { cjk, otherLetter } = countScriptChars(text);
  if (cjk === 0) return false;
  return cjk >= otherLetter;
}

/**
 * Reject model titles whose script does not match the user request.
 * Main failure mode: Chinese-default models (OpenRouter free tier, GLM, etc.) return
 * Chinese titles for English prompts — including mixed labels like "PPT制作".
 *
 * English titles for CJK prompts are allowed.
 */
export function isTitleLanguageCompatible(sourcePrompt: string, title: string): boolean {
  if (!title.trim()) return false;
  // Non-CJK / Latin-dominant prompts must never store CJK titles.
  if (!isPrimarilyCjkText(sourcePrompt) && hasCjkText(title)) {
    return false;
  }
  return true;
}

export function shouldGenerateTitle(input: TitleDecisionInput): boolean {
  if (input.hasAttempted) return false;
  if (input.userMessageCount !== 1) return false;
  const defaultTitle = getDefaultTitleFromPrompt(input.prompt);
  return input.currentTitle === defaultTitle || input.currentTitle === DEFAULT_SESSION_TITLE;
}

export function normalizeGeneratedTitle(
  value: string | null | undefined,
  sourcePrompt?: string
): string | null {
  if (!value) return null;
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const normalized = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!normalized) return null;
  if (
    normalized.toLowerCase() === '(no content)' ||
    normalized.toLowerCase() === '(empty content)'
  ) {
    return null;
  }
  if (sourcePrompt !== undefined && !isTitleLanguageCompatible(sourcePrompt, normalized)) {
    return null;
  }
  return normalized.slice(0, 120);
}

export function buildTitlePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  const languageRule = isPrimarilyCjkText(trimmed)
    ? '- Write the title in the same CJK language as the user request'
    : [
        '- Write the title in English only',
        '- Do not use Chinese, Japanese, Korean, or any other non-Latin scripts',
      ].join('\n');

  return [
    'Generate a short conversation title for the following user request.',
    '- About 6 words maximum (or at most 15 characters if the title is CJK)',
    languageRule,
    '- Do not add quotes, numbering, or trailing punctuation',
    '- Output only the title text, nothing else',
    '',
    `User request: ${trimmed}`,
  ].join('\n');
}
