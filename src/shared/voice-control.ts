/**
 * Hands-free voice control: config, deep links, and the fixed tool set the
 * Realtime model may call. Shared by main, preload, and renderer.
 */

export const VOICE_REALTIME_MODEL_DEFAULT = 'gpt-realtime-2.1-mini';
export const VOICE_DEEP_LINK_SCHEME = 'york';
export const DEFAULT_VOICE_HOTKEY = 'Alt+Space';
export const VOICE_FOLLOW_UP_MIN_SECONDS = 5;
export const VOICE_FOLLOW_UP_MAX_SECONDS = 120;

export type VoiceTriggerSource = 'siri' | 'hotkey' | 'menu' | 'settings';

export interface VoiceControlConfig {
  enabled: boolean;
  /** Seconds of silence after the last turn before the session closes. */
  followUpSeconds: number;
  /** Global accelerator; `null` disables it. */
  hotkey: string | null;
}

export const DEFAULT_VOICE_CONTROL: VoiceControlConfig = {
  enabled: true,
  followUpSeconds: 20,
  hotkey: DEFAULT_VOICE_HOTKEY,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeVoiceControlConfig(raw: unknown): VoiceControlConfig {
  const input = raw && typeof raw === 'object' ? (raw as Partial<VoiceControlConfig>) : {};
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;
  const followUp =
    typeof input.followUpSeconds === 'number' && Number.isFinite(input.followUpSeconds)
      ? Math.round(
          clamp(input.followUpSeconds, VOICE_FOLLOW_UP_MIN_SECONDS, VOICE_FOLLOW_UP_MAX_SECONDS)
        )
      : DEFAULT_VOICE_CONTROL.followUpSeconds;
  const hotkey =
    input.hotkey === null
      ? null
      : typeof input.hotkey === 'string' && input.hotkey.trim()
        ? input.hotkey.trim()
        : DEFAULT_VOICE_CONTROL.hotkey;

  return {
    enabled: bool(input.enabled, DEFAULT_VOICE_CONTROL.enabled),
    followUpSeconds: followUp,
    hotkey,
  };
}

export type VoiceDeepLinkAction = 'start' | 'stop' | 'toggle';

/** Parses `york://voice`, `york://voice/stop`, `york://voice?action=toggle`. */
export function parseVoiceDeepLink(raw: string): VoiceDeepLinkAction | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${VOICE_DEEP_LINK_SCHEME}:`) return null;
  const segments = [url.hostname, ...url.pathname.split('/')]
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (segments[0] !== 'voice') return null;
  const action = (segments[1] ?? url.searchParams.get('action') ?? 'start').toLowerCase();
  return action === 'start' || action === 'stop' || action === 'toggle' ? action : null;
}

export type VoiceActionName =
  | 'scroll'
  | 'switch_tab'
  | 'open_app'
  | 'focus_app'
  | 'press_keys'
  | 'type_text'
  | 'stop_listening';

export interface VoiceActionResult {
  ok: boolean;
  message: string;
  /** The action changes content; the model must get a spoken "confirm" and retry with `confirmed: true`. */
  needsConfirmation?: boolean;
}

export interface VoiceSessionCredentials {
  clientSecret: string;
  model: string;
}

export interface VoiceOverlayInit {
  source: VoiceTriggerSource;
  followUpSeconds: number;
}

export const VOICE_SYSTEM_PROMPT = [
  "You control the user's Mac by voice. The user speaks short commands like",
  '"scroll down", "next tab", "open Slack", "type hello team".',
  'Prefer exactly one tool call per command and act immediately; do not ask clarifying',
  'questions unless the command is truly ambiguous.',
  'After acting, confirm in under 5 words (for example "Done." or "Opening Slack.").',
  'If a tool result says it needs confirmation, ask the user to say "confirm",',
  'and only retry with confirmed=true after they clearly confirm.',
  'When the user says "stop", "that\'s all", "never mind" or thanks you, call stop_listening.',
  'Speak English and keep every reply very short.',
].join(' ');

const CONFIRMED_PROPERTY = {
  type: 'boolean',
  description: 'Set true only after the user explicitly said "confirm" for this exact action.',
} as const;

/** Function tools in the OpenAI Realtime session format. */
export const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'scroll',
    description: 'Scroll the frontmost window.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount: {
          type: 'string',
          enum: ['small', 'page'],
          description: 'small = a few lines, page = one screen. Default page.',
        },
      },
      required: ['direction'],
    },
  },
  {
    type: 'function',
    name: 'switch_tab',
    description: 'Switch tabs in the frontmost app (browser, editor, terminal).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['next', 'previous', 'number'] },
        number: {
          type: 'integer',
          minimum: 1,
          maximum: 9,
          description: 'Tab number when target=number.',
        },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'open_app',
    description:
      'Open (or bring forward) an installed macOS app by name, e.g. "Slack", "Google Chrome".',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'focus_app',
    description: 'Bring an already-running app to the front.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'press_keys',
    description:
      'Press a keyboard shortcut in the frontmost app, written like "cmd+shift+t", "escape", "cmd+f". ' +
      'Closing, quitting, deleting, or sending (enter) needs confirmation.',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string' },
        confirmed: CONFIRMED_PROPERTY,
      },
      required: ['keys'],
    },
  },
  {
    type: 'function',
    name: 'type_text',
    description:
      'Type text into the focused field of the frontmost app. Set submit=true to press Enter afterwards (needs confirmation).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        submit: { type: 'boolean' },
        confirmed: CONFIRMED_PROPERTY,
      },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'stop_listening',
    description: 'End the voice session and turn the microphone off.',
    parameters: { type: 'object', properties: {} },
  },
] as const;
