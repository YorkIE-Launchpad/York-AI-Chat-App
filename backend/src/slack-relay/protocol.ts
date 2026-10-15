/**
 * Wire protocol for `/slack-relay/ws` (mirrored in the desktop at
 * src/main/remote/channels/slack/slack-relay-protocol.ts — keep both in sync).
 *
 * Desktop → backend: register, ping, reply (+footer), status (+label, running step total),
 * approval, approval_closed, question, question_closed, chat_list, picker, notice.
 * Backend → desktop: registered (+features), pong, event (+images), reply_result, action.
 * New frame types are only sent to peers that declared the matching capability
 * in `register`, and desktops only send `question` / `picker` when `registered.features`
 * lists it, so older peers on either side keep working.
 */

export const RELAY_CAPABILITIES = ['status', 'approvals', 'commands', 'images'] as const;
export type RelayCapability = (typeof RELAY_CAPABILITIES)[number];

export const STATUS_PHASES = ['start', 'thinking', 'step', 'done', 'error'] as const;
export type StatusPhase = (typeof STATUS_PHASES)[number];

export const APPROVAL_OUTCOMES = ['allowed', 'denied', 'expired'] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/** Optional frames this backend accepts; sent in `registered` so newer desktops can feature-detect. */
export const SERVER_FEATURES = ['questions', 'pickers'] as const;

/** Button lists the desktop can post; a click comes back as the `pick` command. */
export const PICKER_KINDS = ['model', 'workspace'] as const;
export type PickerKind = (typeof PICKER_KINDS)[number];

export const QUESTION_OUTCOMES = ['answered', 'skipped', 'expired'] as const;
export type QuestionOutcome = (typeof QUESTION_OUTCOMES)[number];

/** Commands a user can type after `/growthos`. `open` and `pick` are button-only (need a token). */
export const TYPED_COMMANDS = [
  'new',
  'chats',
  'model',
  'workspace',
  'stop',
  'status',
  'help',
] as const;
export const COMMAND_NAMES = [...TYPED_COMMANDS, 'open', 'pick'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export const SLASH_COMMAND = '/growthos';

/** Desktop-generated approval ids and chat tokens. */
export const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const PROTOCOL_LIMITS = {
  statusLabel: 120,
  toolName: 100,
  approvalSummary: 300,
  approvalDetail: 2_500,
  approvalMinSec: 5,
  approvalMaxSec: 900,
  chatTitle: 120,
  chatUpdatedLabel: 40,
  chatListMax: 10,
  notice: 3_000,
  footer: 200,
  commandArg: 4_000,
  questionsMax: 4,
  questionOptionsMax: 6,
  questionText: 600,
  questionHeader: 60,
  optionLabel: 75,
  optionDescription: 240,
  answerLabel: 120,
  pickerItemsMax: 20,
  pickerLabel: 120,
  pickerDetail: 150,
  pickerNote: 300,
} as const;

/** Images attached to a DM, forwarded inline (base64) on the `event` frame. */
export const IMAGE_LIMITS = {
  /** Files looked at per message; Slack allows up to 10. */
  filesMax: 10,
  imagesMax: 4,
  /** Model limit is 5 MB of base64 per image. */
  imageMaxBytes: 3_750_000,
  totalMaxBytes: 8_000_000,
  fileNameMax: 120,
} as const;

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Detect the image type from its bytes; Slack's declared mimetype is not trusted. */
export function sniffImageType(data: Uint8Array): ImageMediaType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end));
  if (data.length >= 8 && data[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Trimmed single-line string capped at `max`, or null when empty / not a string. */
export function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Trimmed multi-line string capped at `max`, or null when empty / not a string. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
