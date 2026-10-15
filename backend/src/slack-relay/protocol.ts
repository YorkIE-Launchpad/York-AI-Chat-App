/**
 * Wire protocol for `/slack-relay/ws` (mirrored in the desktop at
 * src/main/remote/channels/slack/slack-relay-protocol.ts — keep both in sync).
 *
 * Desktop → backend: register, ping, reply (+footer), status (+label, running step total),
 * approval, approval_closed,
 * chat_list, notice. Backend → desktop: registered, pong, event, reply_result,
 * action. New frame types are only sent to peers that declared the matching
 * capability in `register`, so older desktops keep working.
 */

export const RELAY_CAPABILITIES = ['status', 'approvals', 'commands'] as const;
export type RelayCapability = (typeof RELAY_CAPABILITIES)[number];

export const STATUS_PHASES = ['start', 'thinking', 'step', 'done', 'error'] as const;
export type StatusPhase = (typeof STATUS_PHASES)[number];

export const APPROVAL_OUTCOMES = ['allowed', 'denied', 'expired'] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/** Commands a user can type after `/growth`. `open` is button-only (needs a chat token). */
export const TYPED_COMMANDS = ['new', 'chats', 'stop', 'status', 'help'] as const;
export const COMMAND_NAMES = [...TYPED_COMMANDS, 'open'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export const SLASH_COMMAND = '/growth';

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
} as const;

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
