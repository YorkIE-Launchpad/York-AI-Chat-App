import type { Message, TraceStep } from '../types';

/** True when the message includes non-empty assistant text (not tool-only). */
export function messageHasAssistantText(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  return message.content.some(
    (block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== ''
  );
}

/** True when the message includes one or more tool_use blocks. */
export function messageHasToolUse(message: Message): boolean {
  return message.content.some((block) => block.type === 'tool_use');
}

/**
 * Clear activeTurn from stream.message only for a final-ish text reply.
 * Text+tool_use turns must keep the turn active so later partials still render.
 */
export function shouldClearActiveTurnOnStreamMessage(message: Message): boolean {
  return messageHasAssistantText(message) && !messageHasToolUse(message);
}

/** Compaction progress steps must not rebind activeTurn.stepId. */
export function isCompactionTraceStep(step: Pick<TraceStep, 'id' | 'title'>): boolean {
  if (step.id.startsWith('compaction-')) return true;
  return /compacting context/i.test(step.title);
}

/** Optimistic mock step id used before the real thinking step arrives. */
export function isPendingStepId(stepId: string): boolean {
  return stepId.startsWith('pending-step-');
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
