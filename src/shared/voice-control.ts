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
  | 'do_on_screen'
  | 'look_at_screen'
  | 'web_search'
  | 'read_webpage'
  | 'open_url'
  | 'ask_growthos'
  | 'write'
  | 'set_model'
  | 'get_model'
  | 'stop_listening';

/** Live state of a `write` draft, shown as a card in the voice overlay. */
export interface VoiceDraftUpdate {
  phase: 'drafting' | 'pasted' | 'failed';
  instruction: string;
  text: string;
  /** Shown under the draft, e.g. why pasting failed. */
  note?: string;
}

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
  "You control the user's Mac by voice. Work out what the user wants from their words and",
  'the conversation so far, then call the right tool right away. Users rarely name the tool:',
  'they will not say "click" or "write", so decide from intent.',
  '',
  'do_on_screen sees the screen and can click, pick from dropdowns and menus, fill search',
  'boxes and fields, select items, toggle settings, and open links in several steps. Use it',
  'for anything about something visible: "change the project to Hub", "pick last week",',
  '"search for invoices", "open the second result", "go to settings", "select all unread",',
  '"turn on dark mode", "that one". When unsure which tool fits, use do_on_screen.',
  'Give do_on_screen a complete, self-contained goal: resolve "this", "that", "it", "the',
  'other one" from earlier turns (for example "In the project dropdown, select Hub Revamp").',
  '',
  'write drafts text from what is on screen and pastes it into the focused box: replies,',
  'messages, emails, comments ("reply saying I can make it", "tell him thanks", "draft a',
  'polite no"). If the box is not focused, first call do_on_screen to focus it. Never send',
  'after writing unless asked. The draft is shown on screen, so do not read it aloud; say "Drafted."',
  'type_text is only for dictating exact words the user spells out ("type: see you at 5").',
  '',
  'Keyboard tools are only for explicit generic commands: scroll for "scroll down/up";',
  'switch_tab only when the user literally says next tab, previous tab, or tab number N;',
  'press_keys when they name keys; open_app / focus_app to open or switch apps by name.',
  'Changing a project, workspace, channel, folder, filter, or view is do_on_screen, never switch_tab.',
  '',
  'Questions and research: look_at_screen answers questions about what is visible ("what does',
  'this error say", "summarize this page", "who sent that"). web_search for public facts, news,',
  'prices, weather, docs; read_webpage to read a specific URL from the results. open_url opens a',
  'website in the browser ("open github.com", "pull up that link").',
  'ask_growthos runs a full GrowthOS agent with all company tools: York Hub (people, leave,',
  'projects, timesheets), Slack, Gmail, Google Calendar and Drive, Jira, Confluence, Launchpad,',
  'meetings, files, and skills. Use it for work data and multi-step tasks ("who is on leave',
  'today", "what is on my calendar", "summarize unread Slack", "create a Jira ticket for this").',
  'Give it a complete task with references resolved. It can take a while: before calling it say',
  '"On it." Then speak the answer it returns briefly, in your own words.',
  'For answers from these tools, speak the gist in 1-3 short sentences; never read URLs aloud.',
  '',
  'set_model switches the GrowthOS AI model ("use Opus", "switch to GPT", "back to auto");',
  'if it lists several options, ask which one. get_model says which model is in use.',
  '',
  'Ask a clarifying question only when the request is truly ambiguous even with context.',
  'After acting, confirm in under 6 words (for example "Done." or "Switched to Hub.").',
  'If a tool fails, say why in one short sentence. If a result needs confirmation, ask the',
  'user to say "confirm" and only retry with confirmed=true after they clearly confirm.',
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
    name: 'do_on_screen',
    description:
      'Default tool for anything involving the visible screen. It looks at the screen and takes as many steps as needed: ' +
      'clicking buttons and links, opening dropdowns and picking options, choosing from menus, typing into search boxes or fields, ' +
      'selecting list items, toggling settings, scrolling a specific pane. Sending, deleting, or submitting needs confirmation.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'The complete outcome to reach, self-contained with references resolved from the conversation, e.g. ' +
            '"In the project dropdown, select Hub Revamp", "Search for invoices in the search bar and press enter", ' +
            '"Open the second search result".',
        },
        confirmed: CONFIRMED_PROPERTY,
      },
      required: ['goal'],
    },
  },
  {
    type: 'function',
    name: 'look_at_screen',
    description:
      'Answer a question about what is currently on screen (read text, summarize a page, explain an error). Does not click.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question, self-contained, e.g. "What does the error dialog say?".',
        },
      },
      required: ['question'],
    },
  },
  {
    type: 'function',
    name: 'web_search',
    description:
      'Search the public web. Returns titles, snippets, and URLs. Use for facts, news, prices, weather, docs.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'read_webpage',
    description: 'Fetch a web page and return its text, e.g. a result from web_search.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'open_url',
    description: 'Open a website or link in the default browser.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL or domain, e.g. "github.com/york-ie".' },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'ask_growthos',
    description:
      'Hand a task to the full GrowthOS agent, which has every company tool: York Hub, Slack, Gmail, ' +
      'Google Calendar and Drive, Jira, Confluence, Launchpad, meetings, files, skills, and web research. ' +
      'Use for work questions and multi-step tasks. Returns its answer; may take up to a couple of minutes. ' +
      'The conversation is saved as a GrowthOS chat.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'Complete, self-contained request with references resolved, e.g. "Who in the Hub Revamp project is on leave this week?".',
        },
      },
      required: ['task'],
    },
  },
  {
    type: 'function',
    name: 'scroll',
    description:
      'Scroll the frontmost window when the user simply says scroll up/down/to top/to bottom.',
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
    description:
      'Keyboard tab switch (Ctrl+Tab) in a browser or editor. Only when the user literally says "next tab", ' +
      '"previous tab", or "tab 3". Not for projects, workspaces, channels, filters, or in-page tabs; use do_on_screen.',
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
    name: 'write',
    description:
      'Look at the screen (the conversation, email, or page the user is on), draft text following the instruction, ' +
      'and paste it into the focused text box. Does not send.',
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description:
            'What to write, in the user\'s words plus any tone or length, e.g. "reply that I can join at 5, friendly".',
        },
      },
      required: ['instruction'],
    },
  },
  {
    type: 'function',
    name: 'set_model',
    description:
      'Switch the AI model GrowthOS uses for chats and for drafting, e.g. "Opus", "GPT 5", "Gemini Flash", or "auto".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The model name as the user said it.' },
      },
      required: ['name'],
    },
  },
  {
    type: 'function',
    name: 'get_model',
    description: 'Say which AI model GrowthOS is currently using and which ones are available.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'stop_listening',
    description: 'End the voice session and turn the microphone off.',
    parameters: { type: 'object', properties: {} },
  },
] as const;
