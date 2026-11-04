/**
 * Voice buttons: presets that turn a spoken take into finished text.
 * Pure types and transforms shared by the main process and the renderer.
 */

import { canonicalAccelerator, parseAccelerator } from './screen-snap';

export const VOICE_CLEANUP_MODEL = 'claude-haiku-5-5';
export const VOICE_CLEANUP_TIMEOUT_MS = 8_000;
export const VOICE_MAX_RECORDING_MS = 60_000;
export const VOICE_DAILY_UTTERANCE_CAP = 150;
export const VOICE_DAILY_AUDIO_CAP_MS = 60 * 60 * 1000;
export const VOICE_HISTORY_CAP = 200;
export const VOICE_RATE_LIMIT = 30;
export const VOICE_RATE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_VOICE_HOTKEY = 'Control+Shift+D';

export const VOICE_BUTTON_ICONS = [
  'sparkles',
  'mic',
  'mail',
  'note',
  'list',
  'pen',
  'message',
] as const;

export type VoiceButtonIcon = (typeof VOICE_BUTTON_ICONS)[number];
export type VoiceButtonMode = 'raw' | 'clean' | 'rewrite';
export type VoiceRewritePreset = 'email' | 'linkedin' | 'crm' | 'task' | 'summary' | 'custom';
export type VoiceInsertMode = 'insert' | 'copy' | 'insert_and_copy';

export interface VoiceButton {
  id: string;
  name: string;
  icon: VoiceButtonIcon;
  mode: VoiceButtonMode;
  rewritePreset: VoiceRewritePreset | null;
  instruction: string;
  language: string;
  tone: string;
  insertMode: VoiceInsertMode;
  sortOrder: number;
}

export interface VoiceButtonDraft {
  id?: string;
  name: string;
  icon: VoiceButtonIcon;
  mode: VoiceButtonMode;
  rewritePreset?: VoiceRewritePreset | null;
  instruction?: string;
  language?: string;
  tone?: string;
  insertMode: VoiceInsertMode;
  sortOrder?: number;
}

export interface VoiceDictionaryEntry {
  id: string;
  term: string;
  replacement: string;
}

export interface VoiceSnippet {
  id: string;
  trigger: string;
  expansion: string;
}

export interface VoiceHistoryEntry {
  id: string;
  buttonId: string | null;
  buttonName: string;
  rawText: string;
  outputText: string;
  degraded: boolean;
  createdAt: number;
}

export interface VoiceButtonsConfig {
  enabled: boolean;
  historyEnabled: boolean;
  hotkeyEnabled: boolean;
  hotkey: string;
  hidden: boolean;
  activeButtonId: string | null;
  /**
   * When true, the hotkey works outside GrowthOS and finished text is pasted
   * into the frontmost app. macOS uses hold-to-talk; Windows uses press-to-toggle.
   */
  systemWide: boolean;
}

export const DEFAULT_VOICE_BUTTONS_CONFIG: VoiceButtonsConfig = {
  enabled: false,
  historyEnabled: true,
  hotkeyEnabled: true,
  hotkey: DEFAULT_VOICE_HOTKEY,
  hidden: false,
  activeButtonId: null,
  systemWide: true,
};

export interface VoiceProcessSuccess {
  ok: true;
  raw: string;
  output: string;
  degraded: boolean;
  insertMode: VoiceInsertMode;
  historyId: string | null;
  buttonName: string;
}

export interface VoiceProcessFailure {
  ok: false;
  code: 'unauthorized' | 'disabled' | 'empty' | 'quota' | 'rate' | 'not_found' | 'failed';
  message: string;
  raw: string;
}

export type VoiceProcessResult = VoiceProcessSuccess | VoiceProcessFailure;

const RESERVED_HOTKEYS = ['Option+Space', 'Command+Shift+Space', 'Command+Shift+G'];

export function normalizeVoiceButtonsConfig(raw: unknown): VoiceButtonsConfig {
  const input = raw && typeof raw === 'object' ? (raw as Partial<VoiceButtonsConfig>) : {};
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;
  const hotkey =
    typeof input.hotkey === 'string' && parseAccelerator(input.hotkey)
      ? canonicalAccelerator(input.hotkey) || DEFAULT_VOICE_HOTKEY
      : DEFAULT_VOICE_HOTKEY;
  const active =
    typeof input.activeButtonId === 'string' && input.activeButtonId.trim()
      ? input.activeButtonId.trim()
      : null;
  return {
    enabled: bool(input.enabled, false),
    historyEnabled: bool(input.historyEnabled, true),
    hotkeyEnabled: bool(input.hotkeyEnabled, true),
    hotkey,
    hidden: bool(input.hidden, false),
    activeButtonId: active,
    systemWide: bool(input.systemWide, true),
  };
}

export function validateVoiceHotkey(
  accelerator: string
): { ok: true; hotkey: string } | { ok: false; reason: 'invalid' | 'reserved' } {
  const canonical = canonicalAccelerator(accelerator);
  if (!canonical) return { ok: false, reason: 'invalid' };
  if (RESERVED_HOTKEYS.includes(canonical)) return { ok: false, reason: 'reserved' };
  return { ok: true, hotkey: canonical };
}

/** True when a keyup should end a hold-to-talk take for this accelerator. */
export function holdKeyMatches(accelerator: string, code: string): boolean {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return false;
  const key = parsed.key;
  if (/^[A-Z]$/.test(key)) return code === `Key${key}`;
  if (/^[0-9]$/.test(key)) return code === `Digit${key}`;
  if (key === 'Space') return code === 'Space';
  return code === key;
}

export function defaultVoiceButtonDrafts(): VoiceButtonDraft[] {
  return [
    {
      name: 'Clean',
      icon: 'sparkles',
      mode: 'clean',
      instruction:
        'Clean this dictation. Remove filler and false starts. Keep the speaker meaning, person, and tense.',
      language: 'en',
      tone: 'neutral',
      insertMode: 'insert_and_copy',
    },
    {
      name: 'Raw',
      icon: 'mic',
      mode: 'raw',
      instruction: '',
      language: 'en',
      tone: 'neutral',
      insertMode: 'insert',
    },
    {
      name: 'Email',
      icon: 'mail',
      mode: 'rewrite',
      rewritePreset: 'email',
      instruction:
        'Rewrite as an email the user can send. Professional and concise. Do not invent a recipient or a subject they did not say.',
      language: 'en',
      tone: 'professional',
      insertMode: 'insert_and_copy',
    },
    {
      name: 'CRM note',
      icon: 'note',
      mode: 'rewrite',
      rewritePreset: 'crm',
      instruction: 'Rewrite as a CRM note. Factual, past tense, and short.',
      language: 'en',
      tone: 'concise',
      insertMode: 'insert_and_copy',
    },
    {
      name: 'Task',
      icon: 'list',
      mode: 'rewrite',
      rewritePreset: 'task',
      instruction:
        'Rewrite as a task title plus bullet steps. Include only steps the speaker asked for.',
      language: 'en',
      tone: 'plain',
      insertMode: 'insert_and_copy',
    },
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceWholePhrases(text: string, pairs: Array<{ from: string; to: string }>): string {
  const usable = pairs
    .map((pair) => ({ from: pair.from.trim(), to: pair.to }))
    .filter((pair) => pair.from.length > 0)
    .sort((a, b) => b.from.length - a.from.length);
  let out = text;
  const tokens: string[] = [];
  usable.forEach((pair, index) => {
    const token = `\u0000VP${index}\u0000`;
    const pattern = new RegExp(`\\b${escapeRegExp(pair.from)}\\b`, 'gi');
    if (!pattern.test(out)) {
      tokens.push('');
      return;
    }
    pattern.lastIndex = 0;
    out = out.replace(pattern, token);
    tokens.push(pair.to);
  });
  tokens.forEach((replacement, index) => {
    if (!replacement) return;
    out = out.split(`\u0000VP${index}\u0000`).join(replacement);
  });
  return out;
}

export function applyDictionary(
  text: string,
  entries: Array<Pick<VoiceDictionaryEntry, 'term' | 'replacement'>>
): string {
  return replaceWholePhrases(
    text,
    entries
      .filter((entry) => entry.replacement.trim().length > 0)
      .map((entry) => ({ from: entry.term, to: entry.replacement }))
  );
}

export function applySnippets(
  text: string,
  snippets: Array<Pick<VoiceSnippet, 'trigger' | 'expansion'>>
): string {
  return replaceWholePhrases(
    text,
    snippets
      .filter((snippet) => snippet.expansion.length > 0)
      .map((snippet) => ({ from: snippet.trigger, to: snippet.expansion }))
  );
}

export function renderVoiceInstruction(
  template: string,
  vars: { transcript: string; tone: string; language: string }
): string {
  return template
    .replaceAll('{{transcript}}', vars.transcript)
    .replaceAll('{{tone}}', vars.tone)
    .replaceAll('{{language}}', vars.language);
}

export function buildVoiceCleanupMessages(input: {
  button: VoiceButton;
  transcript: string;
  dictionary: Array<Pick<VoiceDictionaryEntry, 'term' | 'replacement'>>;
}): { system: string; user: string } {
  const dictionaryLines = input.dictionary
    .filter((entry) => entry.term.trim() && entry.replacement.trim())
    .map((entry) => `- ${entry.term.trim()} = ${entry.replacement.trim()}`)
    .join('\n');
  const instruction = renderVoiceInstruction(input.button.instruction.trim(), {
    transcript: input.transcript,
    tone: input.button.tone,
    language: input.button.language,
  });
  const system = [
    'You turn speech transcripts into finished text for a desktop app.',
    'Remove filler words and false starts.',
    'Fix punctuation and grammar.',
    'When the speaker corrects themselves, keep only the correction.',
    'Keep dictionary spellings exactly.',
    'Do not add facts, recipients, or offers that were not said.',
    'Expanded snippets are already in the transcript. Keep them verbatim.',
    'Return only the finished text.',
  ].join('\n');
  const user = [
    `Mode: ${input.button.mode}`,
    input.button.rewritePreset ? `Preset: ${input.button.rewritePreset}` : '',
    `Tone: ${input.button.tone || 'neutral'}`,
    `Language: ${input.button.language || 'en'}`,
    dictionaryLines ? `Dictionary:\n${dictionaryLines}` : 'Dictionary: (none)',
    instruction ? `Instruction:\n${instruction}` : '',
    'Transcript:',
    input.transcript,
  ]
    .filter(Boolean)
    .join('\n');
  return { system, user };
}

const MODES = new Set<VoiceButtonMode>(['raw', 'clean', 'rewrite']);
const PRESETS = new Set<VoiceRewritePreset>([
  'email',
  'linkedin',
  'crm',
  'task',
  'summary',
  'custom',
]);
const INSERTS = new Set<VoiceInsertMode>(['insert', 'copy', 'insert_and_copy']);

export function sanitizeVoiceButtonDraft(raw: unknown): VoiceButtonDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Partial<VoiceButtonDraft>;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 40) : '';
  if (!name) return null;
  if (!MODES.has(input.mode as VoiceButtonMode)) return null;
  if (!INSERTS.has(input.insertMode as VoiceInsertMode)) return null;
  const icon = VOICE_BUTTON_ICONS.includes(input.icon as VoiceButtonIcon)
    ? (input.icon as VoiceButtonIcon)
    : 'mic';
  const preset = PRESETS.has(input.rewritePreset as VoiceRewritePreset)
    ? (input.rewritePreset as VoiceRewritePreset)
    : input.mode === 'rewrite'
      ? 'custom'
      : null;
  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
    name,
    icon,
    mode: input.mode as VoiceButtonMode,
    rewritePreset: preset,
    instruction:
      typeof input.instruction === 'string' ? input.instruction.trim().slice(0, 2000) : '',
    language:
      typeof input.language === 'string' && input.language.trim()
        ? input.language.trim().slice(0, 16)
        : 'en',
    tone:
      typeof input.tone === 'string' && input.tone.trim()
        ? input.tone.trim().slice(0, 40)
        : 'neutral',
    insertMode: input.insertMode as VoiceInsertMode,
    sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : undefined,
  };
}

export function voiceUsageDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
