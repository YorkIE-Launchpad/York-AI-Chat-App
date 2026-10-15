/**
 * Wire protocol for the York backend Slack relay (mirrored in the backend at
 * backend/src/slack-relay/protocol.ts — keep both in sync).
 */

export const SLACK_RELAY_CAPABILITIES = ['status', 'approvals', 'commands'] as const;

export type SlackRelayStatusPhase = 'start' | 'thinking' | 'step' | 'done' | 'error';
export type SlackRelayApprovalOutcome = 'allowed' | 'denied' | 'expired';
export type SlackRelayCommandName = 'new' | 'chats' | 'stop' | 'status' | 'help' | 'open';

const COMMAND_NAMES: readonly SlackRelayCommandName[] = [
  'new',
  'chats',
  'stop',
  'status',
  'help',
  'open',
];

export const SLACK_RELAY_SLASH_COMMAND = '/growth';

/** Approval ids and chat tokens: random, URL-safe, opaque to the backend. */
export const SLACK_RELAY_OPAQUE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface SlackRelayApprovalRequest {
  approvalId: string;
  toolName: string;
  summary: string;
  detail?: string;
  expiresInSec: number;
}

export interface SlackRelayChatEntry {
  token: string;
  title: string;
  updatedLabel: string;
  current: boolean;
}

export type SlackRelayAction =
  | { kind: 'approval'; approvalId: string; decision: 'allow' | 'deny' }
  | { kind: 'command'; name: SlackRelayCommandName; arg?: string; replyHandle: string };

/** Validate a backend `action` frame; null when malformed. */
export function parseSlackRelayAction(frame: Record<string, unknown>): SlackRelayAction | null {
  if (frame.kind === 'approval') {
    const approvalId = frame.approvalId;
    const decision = frame.decision;
    if (typeof approvalId !== 'string' || !SLACK_RELAY_OPAQUE_ID_RE.test(approvalId)) return null;
    if (decision !== 'allow' && decision !== 'deny') return null;
    return { kind: 'approval', approvalId, decision };
  }
  if (frame.kind === 'command') {
    const name = frame.name;
    const replyHandle = frame.replyHandle;
    if (typeof name !== 'string' || !(COMMAND_NAMES as readonly string[]).includes(name)) {
      return null;
    }
    if (typeof replyHandle !== 'string' || !replyHandle || replyHandle.length > 64) return null;
    const arg = typeof frame.arg === 'string' ? frame.arg.trim().slice(0, 4_000) : '';
    return {
      kind: 'command',
      name: name as SlackRelayCommandName,
      replyHandle,
      ...(arg ? { arg } : {}),
    };
  }
  return null;
}
