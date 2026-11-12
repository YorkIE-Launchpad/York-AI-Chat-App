/**
 * NotifyUser: desktop notification when a chat finishes or needs the user,
 * especially when the window is in the background.
 *
 * The model calls the tool for important moments. afterSessionRun also sends
 * one completion notice if the turn ended, the user is not watching, and the
 * model did not already notify.
 */
import { Type } from '@sinclair/typebox';
import type {
  AgentRuntimeExtension,
  AfterSessionRunContext,
  BeforeSessionRunContext,
  BeforeSessionRunResult,
  AgentRuntimeCustomTool,
} from '../extensions/agent-runtime-extension';
import type { Message } from '../../renderer/types';
import { isGoalCompleteInText } from '../../shared/loop/types';

export const NOTIFY_USER_TOOL_NAME = 'NotifyUser';

export type NotifyUserLevel = 'complete' | 'attention';

export interface NotifyUserNotice {
  sessionId: string;
  title: string;
  body: string;
  level: NotifyUserLevel;
}

export interface NotifyUserHost {
  isEnabled: () => boolean;
  /** True when the user is looking at this session (focused window, this chat on screen). */
  isUserWatching: (sessionId: string) => boolean;
  /** True while a /loop or /goal on this session has not stopped. */
  isLoopRunning: (sessionId: string) => boolean;
  show: (notice: NotifyUserNotice) => void;
}

export interface ParsedNotifyUser {
  title: string;
  body: string;
  level: NotifyUserLevel;
}

/**
 * Session the renderer says is on screen.
 * `undefined` means the renderer has not reported yet.
 */
let foregroundSessionId: string | null | undefined;

export function setForegroundSessionId(sessionId: string | null): void {
  foregroundSessionId = sessionId;
}

export function resetForegroundSessionForTests(): void {
  foregroundSessionId = undefined;
}

/**
 * The user is watching this session when the window is focused and this chat
 * is the one on screen. Until the renderer reports, a focused window counts.
 */
export function isUserWatchingSession(sessionId: string, windowFocused: boolean): boolean {
  if (!windowFocused) return false;
  if (foregroundSessionId === undefined) return true;
  return foregroundSessionId === sessionId;
}

const TITLE_MAX = 80;
const BODY_MAX = 200;

function clampText(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export function parseNotifyUserParams(params: unknown): ParsedNotifyUser | { error: string } {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { error: 'NotifyUser requires title and body.' };
  }
  const root = params as Record<string, unknown>;
  const title = typeof root.title === 'string' ? clampText(root.title, TITLE_MAX) : '';
  const body = typeof root.body === 'string' ? clampText(root.body, BODY_MAX) : '';
  if (!title || !body) {
    return { error: 'NotifyUser requires a non-empty title and body.' };
  }
  const rawLevel = typeof root.level === 'string' ? root.level.trim().toLowerCase() : '';
  const level: NotifyUserLevel = rawLevel === 'complete' ? 'complete' : 'attention';
  return { title, body, level };
}

export function isGoalInProgressText(text: string): boolean {
  return /GOAL_STATUS:\s*in_progress\b/i.test(text);
}

export function latestAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const parts: string[] = [];
    let hasImage = false;
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim());
      }
      if (block.type === 'image') hasImage = true;
    }
    if (parts.length > 0) return parts.join('\n');
    if (hasImage) return '';
  }
  return '';
}

export function assistantHasImage(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    return message.content.some((block) => block.type === 'image');
  }
  return false;
}

export function hasAssistantMessage(messages: Message[]): boolean {
  return messages.some((message) => message?.role === 'assistant');
}

export interface CompletionNotice {
  title: string;
  body: string;
  level: NotifyUserLevel;
}

/** Notice for a finished turn when the model did not call NotifyUser. */
export function buildCompletionNotice(
  sessionTitle: string | undefined,
  messages: Message[]
): CompletionNotice | null {
  if (!hasAssistantMessage(messages)) return null;
  const text = latestAssistantText(messages);
  if (isGoalInProgressText(text)) return null;

  const isError = /\*\*Error\*\*|^\s*Error:/i.test(text);
  const stripped = text
    .replace(/GOAL_STATUS:\s*\S+/gi, '')
    .replace(/\*\*/g, '')
    .trim();
  let body = stripped ? clampText(stripped, BODY_MAX) : '';
  if (!body && isGoalCompleteInText(text)) body = 'Goal finished.';
  if (!body && assistantHasImage(messages)) body = 'Image is ready.';
  if (!body) body = 'The chat finished.';

  const named = sessionTitle?.trim();
  const title = isError
    ? 'Chat needs attention'
    : named && named !== 'New Session'
      ? clampText(named, TITLE_MAX)
      : 'Chat finished';

  return { title, body, level: isError ? 'attention' : 'complete' };
}

function toolResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function createNotifyUserTool(
  extension: NotifyUserExtension,
  sessionId: string
): AgentRuntimeCustomTool {
  return {
    name: NOTIFY_USER_TOOL_NAME,
    label: 'NotifyUser',
    description:
      'Send a desktop notification when the user may not be looking at this chat. ' +
      'Call once when the work is finished (level "complete") or when something important needs them ' +
      '(level "attention": a decision, failure, blocker, or question). ' +
      'Skip greetings, chatter, and intermediate steps such as goal ticks still in_progress or status polls. ' +
      'If the result says notifications are off or the user is already looking, do not retry.',
    parameters: Type.Object({
      title: Type.String({ description: 'Short notification title.' }),
      body: Type.String({ description: 'One sentence: what happened or what the user should do.' }),
      level: Type.Optional(
        Type.Union([Type.Literal('complete'), Type.Literal('attention')], {
          description:
            'complete when the work is done; attention when the user needs to act. Defaults to attention.',
        })
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      return extension.executeNotify(sessionId, params);
    },
  };
}

export class NotifyUserExtension implements AgentRuntimeExtension {
  readonly name = 'notify-user';

  /** Sessions whose current run already showed a notification. */
  private readonly notifiedThisRun = new Set<string>();

  constructor(private readonly host: NotifyUserHost) {}

  async beforeSessionRun(context: BeforeSessionRunContext): Promise<BeforeSessionRunResult> {
    this.notifiedThisRun.delete(context.session.id);
    return {
      customTools: [createNotifyUserTool(this, context.session.id)],
    };
  }

  async afterSessionRun(context: AfterSessionRunContext): Promise<void> {
    const sessionId = context.session.id;
    const alreadyNotified = this.notifiedThisRun.has(sessionId);
    this.notifiedThisRun.delete(sessionId);
    if (alreadyNotified || context.suppressCompletionNotice) return;
    if (!this.host.isEnabled() || this.host.isUserWatching(sessionId)) return;

    const text = latestAssistantText(context.messages);
    if (this.host.isLoopRunning(sessionId) && !isGoalCompleteInText(text)) return;

    const notice = buildCompletionNotice(context.session.title, context.messages);
    if (!notice) return;
    this.host.show({ sessionId, ...notice });
  }

  executeNotify(
    sessionId: string,
    params: unknown
  ): { content: Array<{ type: 'text'; text: string }>; details: undefined } {
    const parsed = parseNotifyUserParams(params);
    if ('error' in parsed) {
      return toolResult(parsed.error);
    }
    if (!this.host.isEnabled()) {
      return toolResult(
        'Desktop notifications are turned off in Settings. Continue without notifying. Do not retry.'
      );
    }
    if (this.host.isUserWatching(sessionId)) {
      return toolResult(
        'The user is looking at the app, so no desktop notification was sent. Do not retry.'
      );
    }
    this.host.show({ sessionId, ...parsed });
    this.notifiedThisRun.add(sessionId);
    return toolResult(`Notification sent (${parsed.level}): ${parsed.title}`);
  }
}
