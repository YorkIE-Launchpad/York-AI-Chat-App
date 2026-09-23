export const DEFAULT_SESSION_TITLE = 'New Session';
const MAX_SESSION_TITLE_LENGTH = 50;
const MAX_SUCCINCT_WORDS = 6;

/** Han, Hiragana, Katakana, Hangul, and common CJK extension blocks. */
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

const SMALL_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'for',
  'nor',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'vs',
]);

const ACRONYMS: Record<string, string> = {
  api: 'API',
  ai: 'AI',
  css: 'CSS',
  et: 'ET',
  ga4: 'GA4',
  html: 'HTML',
  id: 'ID',
  ip: 'IP',
  js: 'JS',
  llm: 'LLM',
  loe: 'LOE',
  pdf: 'PDF',
  ppt: 'PPT',
  pptx: 'PPTX',
  qa: 'QA',
  seo: 'SEO',
  sql: 'SQL',
  ui: 'UI',
  url: 'URL',
  ux: 'UX',
};

const LEADING_PHRASES: RegExp[] = [
  /^(?:hi|hello|hey|yo|hiya|good\s+(?:morning|afternoon|evening))\b[,!.\s]*/i,
  /^(?:if\s+i\s+(?:wanted|want)\s+to|i(?:'d|\s+would)\s+like\s+to|i\s+(?:want|need|wanted)\s+to)\s+/i,
  /^(?:please\s+)?(?:can you|could you|would you|will you|help me(?:\s+to)?|please)\s+/i,
  /^(?:what(?:'s|\s+is|\s+are)|how\s+(?:do\s+i|can\s+i|to)|why\s+(?:is|does|do)|is\s+this|can\s+i|do\s+i)\s+/i,
  /^(?:my|our|the|a|an)\s+/i,
];

function truncateSessionTitle(value: string): string {
  return value.length > MAX_SESSION_TITLE_LENGTH
    ? `${value.slice(0, Math.max(1, MAX_SESSION_TITLE_LENGTH - 3))}...`
    : value;
}

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

export function getDefaultTitleFromPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return DEFAULT_SESSION_TITLE;
  return truncateSessionTitle(trimmed);
}

function normalizeTitleCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a model title is just the opening of the user message.
 * Rewritten topic names ("API Key Check") are kept.
 */
export function isEchoTitle(prompt: string, title: string): boolean {
  const normalizedPrompt = normalizeTitleCompare(prompt);
  const normalizedTitle = normalizeTitleCompare(title);
  if (!normalizedPrompt || !normalizedTitle) return false;
  if (normalizedPrompt === normalizedTitle) return true;

  const titleWords = normalizedTitle.split(' ');
  const promptWords = normalizedPrompt.split(' ');
  return (
    titleWords.length >= 4 &&
    promptWords[0] === titleWords[0] &&
    normalizedPrompt.startsWith(normalizedTitle)
  );
}

function stripLeadingPhrase(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match || match.index !== 0) return text;
  const rest = text.slice(match[0].length).trim();
  if (rest.split(/\s+/).filter(Boolean).length < 2) return text;
  return rest;
}

function titleCaseWord(word: string, isEdge: boolean): string {
  const letters = word.replace(/[^A-Za-z0-9]/g, '');
  const mapped = ACRONYMS[letters.toLowerCase()];
  if (mapped && letters.length > 0) {
    return word.replace(letters, mapped);
  }
  if (letters.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) {
    return word;
  }

  const lower = word.toLowerCase();
  const smallKey = lower.replace(/[^a-z']/g, '');
  if (!isEdge && SMALL_WORDS.has(smallKey)) {
    return lower;
  }
  return lower.replace(/(^|-)([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Local sidebar title: a short topic phrase, without waiting on the model.
 * CJK prompts stay on the raw truncation; the model still names those chats.
 */
export function succinctTitleFromPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return DEFAULT_SESSION_TITLE;
  if (isPrimarilyCjkText(trimmed)) return getDefaultTitleFromPrompt(trimmed);

  let text = trimmed.replace(/\s+/g, ' ');
  for (let pass = 0; pass < LEADING_PHRASES.length; pass += 1) {
    let changed = false;
    for (const pattern of LEADING_PHRASES) {
      const next = stripLeadingPhrase(text, pattern);
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
    if (!changed) break;
  }

  text = (text.split(/[.!?\n]/)[0] ?? text)
    .replace(/\s+please$/i, '')
    .replace(/[?!.:,;]+$/g, '')
    .trim();
  let words = text.split(/\s+/).filter(Boolean).slice(0, MAX_SUCCINCT_WORDS);
  while (
    words.length > 2 &&
    SMALL_WORDS.has(words[words.length - 1].toLowerCase().replace(/[^a-z']/g, ''))
  ) {
    words = words.slice(0, -1);
  }
  if (words.length === 0) return getDefaultTitleFromPrompt(trimmed);

  const titled = words
    .map((word, index) => titleCaseWord(word, index === 0 || index === words.length - 1))
    .join(' ');
  return truncateSessionTitle(titled);
}

/** Titles the app assigned itself and may still replace with a model title. */
export function isAutomaticSessionTitle(currentTitle: string, prompt: string): boolean {
  if (!currentTitle || currentTitle === DEFAULT_SESSION_TITLE) return true;
  if (currentTitle === getDefaultTitleFromPrompt(prompt)) return true;
  return currentTitle === succinctTitleFromPrompt(prompt);
}

export function getInitialSessionTitle(
  prompt: string,
  firstAttachmentName?: string | null
): string {
  const trimmed = prompt.trim();
  if (trimmed) {
    return succinctTitleFromPrompt(trimmed);
  }

  const attachmentName = firstAttachmentName?.trim();
  if (attachmentName) {
    return truncateSessionTitle(attachmentName);
  }

  return DEFAULT_SESSION_TITLE;
}
