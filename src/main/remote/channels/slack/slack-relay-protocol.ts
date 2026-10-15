/**
 * Wire protocol for the York backend Slack relay (mirrored in the backend at
 * backend/src/slack-relay/protocol.ts — keep both in sync).
 */

import type { RemoteInlineImage } from '../../types';

export const SLACK_RELAY_CAPABILITIES = ['status', 'approvals', 'commands', 'images'] as const;

/** Backend caps (4 images, 3.75 MB each, 8 MB total) plus base64 and frame overhead. */
export const SLACK_RELAY_IMAGE_LIMITS = {
  images: 4,
  base64PerImage: 5_000_000,
  frameBytes: 12 * 1024 * 1024,
} as const;

const IMAGE_MEDIA_TYPES: readonly RemoteInlineImage['mediaType'][] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validate the `images` of a backend `event` frame; malformed entries are dropped. */
export function parseSlackRelayImages(value: unknown): RemoteInlineImage[] {
  if (!Array.isArray(value)) return [];
  const images: RemoteInlineImage[] = [];
  for (const raw of value.slice(0, SLACK_RELAY_IMAGE_LIMITS.images)) {
    if (!raw || typeof raw !== 'object') continue;
    const image = raw as Record<string, unknown>;
    const mediaType = image.mediaType as RemoteInlineImage['mediaType'];
    const data = image.data;
    if (!IMAGE_MEDIA_TYPES.includes(mediaType)) continue;
    if (typeof data !== 'string' || !data) continue;
    if (data.length > SLACK_RELAY_IMAGE_LIMITS.base64PerImage || !BASE64_RE.test(data)) continue;
    const name = typeof image.name === 'string' ? image.name.slice(0, 120) : undefined;
    images.push({ mediaType, data, ...(name ? { name } : {}) });
  }
  return images;
}

export type SlackRelayStatusPhase = 'start' | 'thinking' | 'step' | 'done' | 'error';
export type SlackRelayApprovalOutcome = 'allowed' | 'denied' | 'expired';
export type SlackRelayQuestionOutcome = 'answered' | 'skipped' | 'expired';

/** Backend features announced in `registered`; older backends close the socket on unknown frames. */
export type SlackRelayServerFeature = 'questions' | 'pickers';

/** Backend limits for question cards; larger forms fall back to a text prompt. */
export const SLACK_RELAY_QUESTION_LIMITS = { questions: 4, options: 6 } as const;

/** `open` and `pick` are button-only: their arg is a token this desktop issued. */
export type SlackRelayCommandName =
  | 'new'
  | 'chats'
  | 'model'
  | 'workspace'
  | 'stop'
  | 'status'
  | 'help'
  | 'open'
  | 'pick';

const COMMAND_NAMES: readonly SlackRelayCommandName[] = [
  'new',
  'chats',
  'model',
  'workspace',
  'stop',
  'status',
  'help',
  'open',
  'pick',
];

export type SlackRelayPickerKind = 'model' | 'workspace';

export const SLACK_RELAY_PICKER_MAX_ITEMS = 20;

export interface SlackRelayPicker {
  kind: SlackRelayPickerKind;
  items: Array<{ token: string; label: string; detail: string; current: boolean }>;
  note?: string;
}

export const SLACK_RELAY_SLASH_COMMAND = '/growthos';

/** Approval ids and chat tokens: random, URL-safe, opaque to the backend. */
export const SLACK_RELAY_OPAQUE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface SlackRelayApprovalRequest {
  approvalId: string;
  toolName: string;
  summary: string;
  detail?: string;
  expiresInSec: number;
}

export interface SlackRelayQuestionRequest {
  questionId: string;
  expiresInSec: number;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string; recommended?: boolean }>;
  }>;
}

export interface SlackRelayChatEntry {
  token: string;
  title: string;
  updatedLabel: string;
  current: boolean;
}

export type SlackRelayAction =
  | { kind: 'approval'; approvalId: string; decision: 'allow' | 'deny' }
  | { kind: 'command'; name: SlackRelayCommandName; arg?: string; replyHandle: string }
  /** Option indexes per question, or null when the owner pressed Skip. */
  | { kind: 'answer'; questionId: string; answers: number[][] | null };

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
  if (frame.kind === 'answer') {
    const questionId = frame.questionId;
    if (typeof questionId !== 'string' || !SLACK_RELAY_OPAQUE_ID_RE.test(questionId)) return null;
    if (frame.answers === null) return { kind: 'answer', questionId, answers: null };
    const answers = frame.answers;
    if (!Array.isArray(answers) || answers.length > SLACK_RELAY_QUESTION_LIMITS.questions) {
      return null;
    }
    const parsed: number[][] = [];
    for (const picks of answers) {
      if (!Array.isArray(picks) || picks.length > SLACK_RELAY_QUESTION_LIMITS.options) return null;
      if (
        !picks.every(
          (o) => Number.isInteger(o) && o >= 0 && o < SLACK_RELAY_QUESTION_LIMITS.options
        )
      ) {
        return null;
      }
      parsed.push(picks as number[]);
    }
    return { kind: 'answer', questionId, answers: parsed };
  }
  return null;
}
