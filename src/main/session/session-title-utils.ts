export {
  DEFAULT_SESSION_TITLE,
  getDefaultTitleFromPrompt,
  hasCjkText,
  isAutomaticSessionTitle,
  isEchoTitle,
  isPrimarilyCjkText,
  succinctTitleFromPrompt,
} from '../../shared/session-title';
import {
  hasCjkText,
  isAutomaticSessionTitle,
  isPrimarilyCjkText,
} from '../../shared/session-title';

export type TitleDecisionInput = {
  userMessageCount: number;
  currentTitle: string;
  prompt: string;
  hasAttempted: boolean;
};

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
  return isAutomaticSessionTitle(input.currentTitle, input.prompt);
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
  const normalized = firstLine
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(?:title\s*:\s*)/i, '')
    .trim();
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
  return clampGeneratedTitle(normalized);
}

function clampGeneratedTitle(title: string): string {
  if (isPrimarilyCjkText(title)) {
    return title.length > 20 ? title.slice(0, 20) : title;
  }
  const words = title.split(/\s+/).filter(Boolean).slice(0, 8);
  const limited = words.join(' ');
  if (limited.length <= 60) return limited;
  const cut = limited.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim();
}

export function buildTitlePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  const languageRule = isPrimarilyCjkText(trimmed)
    ? '- Write the title in the same CJK language as the user request'
    : [
        '- Write the title in English only',
        '- Do not use Chinese, Japanese, Korean, or any other non-Latin scripts',
      ].join('\n');

  const examples = isPrimarilyCjkText(trimmed)
    ? ['例子：', '用户：帮我把周报整理成一页', '标题：周报整理'].join('\n')
    : [
        'Examples:',
        'User: hello can you check my api key',
        'Title: API Key Check',
        'User: what is my usage limit for this month',
        'Title: Monthly Usage Limit',
        'User: help me convert ET to Indian time',
        'Title: ET to Indian Time',
      ].join('\n');

  return [
    'Write a short sidebar title for this chat so it can be found later.',
    '- 2 to 6 words (or at most 15 characters if the title is CJK)',
    '- Name the topic. Do not copy the user sentence, greeting, or question wording',
    '- English titles use Title Case',
    languageRule,
    '- Do not add quotes, numbering, a "Title:" prefix, or trailing punctuation',
    '- Output only the title text, nothing else',
    '',
    examples,
    '',
    `User request: ${trimmed.slice(0, 2000)}`,
  ].join('\n');
}
