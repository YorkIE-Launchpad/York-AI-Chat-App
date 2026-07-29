import type { Message } from '../types';

/** True when the message includes non-empty assistant text (not tool-only). */
export function messageHasAssistantText(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  return message.content.some(
    (block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== ''
  );
}

/**
 * True when an assistant text reply already exists for the user message
 * anchored by `userMessageId` (ignores tool_result-only assistant rows).
 */
export function hasAssistantTextResponseForTurn(
  messages: Message[],
  userMessageId: string | undefined
): boolean {
  if (!userMessageId) return false;
  const anchorIndex = messages.findIndex((message) => message.id === userMessageId);
  if (anchorIndex === -1) return false;

  for (let i = anchorIndex + 1; i < messages.length; i += 1) {
    if (messages[i].role === 'user') break;
    if (messageHasAssistantText(messages[i])) return true;
  }
  return false;
}

/** Latest user message id in the thread, if any. */
export function findLatestUserMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].id;
  }
  return undefined;
}

/** Collect text blocks for a streaming partial message check. */
export function hasStreamingText(partialMessage: string, partialThinking: string): boolean {
  return Boolean(partialMessage.trim() || partialThinking.trim());
}
