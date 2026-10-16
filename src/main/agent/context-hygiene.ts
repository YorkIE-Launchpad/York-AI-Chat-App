/**
 * Per-request context hygiene for long chats.
 *
 * Every user turn is sent with ephemeral context (turn_context, memory,
 * SuperContext, knowledge source list, active project stamp). Those blocks are
 * only relevant to the turn they were retrieved for, but the SDK keeps them in
 * history, so after many follow-ups the model sees dozens of stale copies that
 * crowd out the actual conversation. These helpers run on a per-request copy of
 * the message list (never the stored history) to:
 * 1. Drop ephemeral blocks from all but the most recent user turns.
 * 2. When the context grows past a budget, shorten old tool outputs to a head
 *    excerpt (never a bare tombstone) — current-turn tool results stay intact.
 */

/** Wrapper the agent runner puts around extension prompt prefixes. */
export const PER_TURN_CONTEXT_TAG = 'per_turn_context';

const EPHEMERAL_TAGS = [
  PER_TURN_CONTEXT_TAG,
  'turn_context',
  'memory_context',
  'knowledge_sources',
  'active_project_context',
  'active_client_context',
];

const EPHEMERAL_BLOCK_RE = new RegExp(
  `\\s*<(${EPHEMERAL_TAGS.join('|')})>[\\s\\S]*?</\\1>\\s*`,
  'g'
);

/**
 * Compaction/budget cap. Models with 1M windows still answer worse (and cost
 * more) when the prompt is hundreds of thousands of tokens of old turns, so
 * compaction and tool-use clearing are tuned against this instead.
 */
export const EFFECTIVE_CONTEXT_CAP_TOKENS = 200_000;

export function effectiveContextWindow(contextWindow: number | undefined | null): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 128_000;
  return Math.min(window, EFFECTIVE_CONTEXT_CAP_TOKENS);
}

export function stripEphemeralBlocks(text: string): string {
  if (!text.includes('<')) return text;
  const stripped = text.replace(EPHEMERAL_BLOCK_RE, '\n\n').trim();
  return stripped === text ? text : stripped;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

function stripMessageContent(message: AnyMessage): AnyMessage {
  const content = message.content;
  if (typeof content === 'string') {
    const next = stripEphemeralBlocks(content);
    return next === content ? message : { ...message, content: next };
  }
  if (!Array.isArray(content)) return message;
  let changed = false;
  const nextContent = content.map((block: AnyMessage) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block;
    const next = stripEphemeralBlocks(block.text);
    if (next === block.text) return block;
    changed = true;
    return { ...block, text: next };
  });
  return changed ? { ...message, content: nextContent } : message;
}

/**
 * Remove ephemeral per-turn blocks from user messages older than the most
 * recent `keepRecentUserTurns` user turns. Returns a new array; inputs are not mutated.
 */
export function stripStaleTurnContext(
  messages: AnyMessage[],
  keepRecentUserTurns = 2
): { messages: AnyMessage[]; strippedCount: number } {
  const userIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message?.role === 'user') userIndexes.push(index);
  });
  const cutoff =
    keepRecentUserTurns <= 0
      ? messages.length
      : userIndexes.length > keepRecentUserTurns
        ? userIndexes[userIndexes.length - keepRecentUserTurns]
        : -1;
  if (cutoff < 0) return { messages, strippedCount: 0 };

  let strippedCount = 0;
  const next = messages.map((message, index) => {
    if (index >= cutoff || message?.role !== 'user') return message;
    const stripped = stripMessageContent(message);
    if (stripped !== message) strippedCount += 1;
    return stripped;
  });
  return { messages: strippedCount > 0 ? next : messages, strippedCount };
}

function textLength(message: AnyMessage): number {
  const content = message?.content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') total += block.text.length;
    else if (typeof block.thinking === 'string') total += block.thinking.length;
    else if (block.type === 'toolCall' || block.type === 'tool_use') {
      try {
        total += JSON.stringify(block.arguments ?? block.input ?? {}).length;
      } catch {
        total += 0;
      }
    }
  }
  return total;
}

export function estimateMessagesChars(messages: AnyMessage[]): number {
  return messages.reduce((sum, message) => sum + textLength(message), 0);
}

export interface TrimToolResultsOptions {
  /** Start trimming once the whole context exceeds this many characters. */
  budgetChars: number;
  /** Tool results after the Nth-most-recent user message are never trimmed. */
  keepRecentUserTurns?: number;
  /** Only outputs longer than this are trimmed. */
  minChars?: number;
  /** Characters of the original output kept as an excerpt. */
  excerptChars?: number;
}

function trimToolResultMessage(message: AnyMessage, excerptChars: number): AnyMessage {
  const original = textLength(message);
  const note = `\n…[earlier tool output trimmed from ${original} chars to keep the conversation focused. Call the tool again if exact details beyond this excerpt are needed.]`;
  const content = message.content;
  if (typeof content === 'string') {
    return { ...message, content: `${content.slice(0, excerptChars)}${note}` };
  }
  let remaining = excerptChars;
  let noted = false;
  const nextContent: AnyMessage[] = [];
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      nextContent.push(block);
      continue;
    }
    if (remaining <= 0) {
      if (!noted) {
        nextContent.push({ type: 'text', text: note.trim() });
        noted = true;
      }
      continue;
    }
    const excerpt = block.text.slice(0, remaining);
    remaining -= excerpt.length;
    const truncated = excerpt.length < block.text.length;
    nextContent.push({ ...block, text: truncated ? `${excerpt}${note}` : excerpt });
    if (truncated) noted = true;
  }
  return { ...message, content: nextContent };
}

/**
 * Shorten old, large tool outputs oldest-first until the context fits
 * `budgetChars`. Returns a new array; inputs are not mutated.
 */
export function trimOldToolResults(
  messages: AnyMessage[],
  options: TrimToolResultsOptions
): { messages: AnyMessage[]; trimmedCount: number } {
  const keepRecentUserTurns = options.keepRecentUserTurns ?? 2;
  const minChars = options.minChars ?? 4000;
  const excerptChars = options.excerptChars ?? 2000;

  let total = estimateMessagesChars(messages);
  if (total <= options.budgetChars) return { messages, trimmedCount: 0 };

  const userIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message?.role === 'user') userIndexes.push(index);
  });
  const protectedFrom =
    keepRecentUserTurns <= 0
      ? messages.length
      : userIndexes.length >= keepRecentUserTurns
        ? userIndexes[userIndexes.length - keepRecentUserTurns]
        : 0;

  const next = [...messages];
  let trimmedCount = 0;
  for (let index = 0; index < protectedFrom && total > options.budgetChars; index += 1) {
    const message = next[index];
    if (message?.role !== 'toolResult') continue;
    const length = textLength(message);
    if (length <= minChars) continue;
    const trimmed = trimToolResultMessage(message, excerptChars);
    total -= length - textLength(trimmed);
    next[index] = trimmed;
    trimmedCount += 1;
  }
  return { messages: trimmedCount > 0 ? next : messages, trimmedCount };
}

/** Full per-request pass used by the live transformContext hook. */
export function applyContextHygiene(
  messages: AnyMessage[],
  contextWindow: number | undefined | null
): { messages: AnyMessage[]; strippedCount: number; trimmedCount: number } {
  const stripped = stripStaleTurnContext(messages);
  // ~4 chars/token; start trimming at half the effective window.
  const budgetChars = Math.floor(effectiveContextWindow(contextWindow) * 4 * 0.5);
  const trimmed = trimOldToolResults(stripped.messages, { budgetChars });
  return {
    messages: trimmed.messages,
    strippedCount: stripped.strippedCount,
    trimmedCount: trimmed.trimmedCount,
  };
}

/**
 * Compaction tuning: trigger against the effective window and keep a larger
 * verbatim tail than the SDK default (20k) so recent turns survive intact.
 */
export function compactionSettingsForWindow(contextWindow: number | undefined | null): {
  enabled: true;
  reserveTokens: number;
  keepRecentTokens: number;
} {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 128_000;
  const effective = effectiveContextWindow(window);
  const baseReserve = 16_384;
  return {
    enabled: true,
    reserveTokens: window - effective + baseReserve,
    keepRecentTokens: Math.min(50_000, Math.max(20_000, Math.floor(effective * 0.2))),
  };
}

/** Summary output budget (the SDK uses 0.8 × reserveTokens as max output tokens). */
export function summaryReserveTokens(modelMaxTokens: number | undefined | null): number {
  const base = 16_384;
  if (!modelMaxTokens || modelMaxTokens <= 0) return base;
  return Math.min(base, Math.floor(modelMaxTokens / 0.8));
}
