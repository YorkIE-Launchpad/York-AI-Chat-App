import {
  getOverflowPatterns,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@mariozechner/pi-ai';

type MessageEndContentBlock = TextContent | ThinkingContent | ToolCall;

type MessageEndMessage = Pick<AssistantMessage, 'role' | 'content' | 'stopReason' | 'errorMessage'>;

interface ResolveMessageEndPayloadOptions {
  message?: MessageEndMessage;
  streamedText: string;
}

interface ResolvedMessageEndPayload {
  effectiveContent: MessageEndContentBlock[];
  errorText?: string;
  nextStreamedText: string;
  shouldEmitMessage: boolean;
}

const FOUR_XX_ERROR_RE = /\b4\d{2}\b/;

export const USAGE_LIMIT_USER_MESSAGE =
  "You've reached your API usage limit. Please contact your admin.";

export const CONTEXT_OVERFLOW_USER_MESSAGE =
  'Context window exceeded: the conversation (plus tools/files) is too large for this model. Compact the session or start a new chat, then retry.';

export interface TerminalErrorEmissionDetails {
  partialText: string;
  messageText: string;
}

export interface AbortDispositionFlags {
  abortedByTimeout: boolean;
  abortedByLoopGuard: boolean;
  abortedByStreamError: boolean;
}

export type AbortDisposition = 'timeout' | 'loop_guard' | 'stream_error' | 'user';

export function isRateLimitError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    /\b429\b/.test(errorText) ||
    lower.includes('rate limit') ||
    lower.includes('rate limited') ||
    lower.includes('too many requests')
  );
}

export function isUsageLimitError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    /\b402\b/.test(errorText) ||
    lower.includes('usage limit') ||
    lower.includes('api usage') ||
    lower.includes('quota exceeded') ||
    lower.includes('out of quota') ||
    lower.includes('regain access') ||
    lower.includes('billing') ||
    lower.includes('more credits') ||
    lower.includes('requires more credits') ||
    lower.includes('can only afford') ||
    lower.includes('insufficient credits') ||
    errorText === USAGE_LIMIT_USER_MESSAGE
  );
}

/** Patterns the pi SDK's isContextOverflow recognizes (compact-and-retry eligible). */
function matchesSdkOverflowPatterns(errorText: string): boolean {
  if (getOverflowPatterns().some((pattern) => pattern.test(errorText))) return true;
  // Cerebras-style: handled in pi-ai isContextOverflow but not in getOverflowPatterns()
  if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(errorText.trim())) return true;
  return false;
}

export function isContextOverflowError(errorText: string): boolean {
  if (!errorText) return false;
  if (errorText === CONTEXT_OVERFLOW_USER_MESSAGE) return true;
  const lower = errorText.toLowerCase();
  if (lower.includes('context overflow recovery failed')) return true;
  if (matchesSdkOverflowPatterns(errorText)) return true;
  // Proxies/gateways often return bare 413 when the request body is too large.
  // Same user guidance as token overflow; SDK will not auto-recover these.
  if (
    /\b413\b/.test(errorText) ||
    lower.includes('payload too large') ||
    lower.includes('request entity too large')
  ) {
    return true;
  }
  return false;
}

/** True when the SDK will compact-and-retry (do not emit/abort yet). */
export function isSdkRecoverableContextOverflowError(errorText: string): boolean {
  if (!errorText) return false;
  return matchesSdkOverflowPatterns(errorText);
}

export function toUserFacingErrorText(errorText: string): string {
  const lower = errorText.toLowerCase();
  if (lower.includes('first_response_timeout')) {
    return 'Model response timed out: no upstream response for a long time. Please retry later or check the current model/gateway load.';
  }
  if (lower.includes('empty_success_result')) {
    return 'The model returned an empty success result. The current model or gateway may have compatibility issues. Please retry or switch protocols.';
  }
  // Usage/quota rejections often arrive as HTTP 400 invalid_request_error — detect before generic 400.
  if (isUsageLimitError(errorText)) {
    return USAGE_LIMIT_USER_MESSAGE;
  }
  // Context / payload overflow (400 prompt-too-long, 413, etc.) — before generic 4xx hints.
  if (isContextOverflowError(errorText)) {
    return CONTEXT_OVERFLOW_USER_MESSAGE;
  }
  if (
    /\b400\b/.test(errorText) ||
    lower.includes('bad request') ||
    lower.includes('invalid request')
  ) {
    return `Request rejected by upstream (400). The model/protocol configuration may be incompatible. Check the model name, protocol settings, and API endpoint.\nOriginal error: ${errorText}`;
  }
  if (
    /\b(401|403)\b/.test(errorText) ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden')
  ) {
    return `Authentication failed. Check that the API key is correct, not expired, and has access to the current model.\nOriginal error: ${errorText}`;
  }
  if (isRateLimitError(errorText)) {
    return `Rate limited (429). The call frequency for the current model or API endpoint has reached its limit. Please retry later or contact your admin.\nOriginal error: ${errorText}`;
  }
  if (
    /\b(5\d{2})\b/.test(errorText) ||
    lower.includes('server error') ||
    lower.includes('internal error') ||
    lower.includes('service unavailable') ||
    lower.includes('overloaded')
  ) {
    return `Upstream service error. The model service may be overloaded or temporarily unavailable. The SDK will retry automatically.\nOriginal error: ${errorText}`;
  }
  if (
    lower.includes('terminated') ||
    lower.includes('connection reset') ||
    lower.includes('connection closed') ||
    lower.includes('connection refused') ||
    lower.includes('connection error') ||
    lower.includes('fetch failed') ||
    lower.includes('other side closed') ||
    lower.includes('reset before headers') ||
    lower.includes('upstream connect') ||
    lower.includes('retry delay')
  ) {
    return `Network connection interrupted (${errorText}). The proxy/gateway may be unstable. The SDK will retry automatically.`;
  }
  return errorText;
}

export function resolveAssistantStreamErrorText(
  event: Extract<AssistantMessageEvent, { type: 'error' }>
): string {
  const rawError = event.error?.errorMessage?.trim() || event.reason || 'stream_error';
  return toUserFacingErrorText(rawError);
}

export function buildTerminalErrorMessage(errorText: string, partialText = ''): string {
  const normalizedPartial = partialText.trimEnd();
  let hint = '_Agent is retrying automatically, please wait..._';
  const lower = errorText.toLowerCase();
  // OpenRouter BYOK limits are user-owned — never tell them to contact York admin.
  if (
    lower.includes('openrouter') &&
    (lower.includes('openrouter.ai') ||
      lower.includes('your key') ||
      lower.includes('york-managed'))
  ) {
    hint =
      '_Add credits, pick a free OpenRouter model, or switch to Hub / Project for York-managed models._';
  } else if (isUsageLimitError(errorText)) {
    hint = '_Contact your admin to restore access._';
  } else if (isRateLimitError(errorText)) {
    hint = '_Please retry later or contact your admin._';
  } else if (isContextOverflowError(errorText)) {
    hint = '_Use Compact in the context bar, or start a new chat._';
  } else if (FOUR_XX_ERROR_RE.test(errorText)) {
    hint = '_Please check your configuration and retry._';
  }
  const errorBlock = `**Error**: ${errorText}\n\n${hint}`;
  return normalizedPartial ? `${normalizedPartial}\n\n${errorBlock}` : errorBlock;
}

export function buildTerminalErrorEmissionDetails(options: {
  errorText: string;
  streamedText: string;
}): TerminalErrorEmissionDetails {
  const partialText = options.streamedText;

  return {
    partialText,
    messageText: buildTerminalErrorMessage(options.errorText, partialText),
  };
}

export function resolveAbortDisposition(flags: AbortDispositionFlags): AbortDisposition {
  if (flags.abortedByTimeout) {
    return 'timeout';
  }
  if (flags.abortedByLoopGuard) {
    return 'loop_guard';
  }
  if (flags.abortedByStreamError) {
    return 'stream_error';
  }
  return 'user';
}

export function shouldPreserveExistingTrace(disposition: AbortDisposition): boolean {
  return disposition === 'loop_guard' || disposition === 'stream_error';
}

export function resolveMessageEndPayload(
  options: ResolveMessageEndPayloadOptions
): ResolvedMessageEndPayload {
  const { message, streamedText } = options;
  const nextStreamedText = '';

  if (message?.stopReason === 'error' && message.errorMessage) {
    return {
      effectiveContent: [],
      errorText: toUserFacingErrorText(message.errorMessage),
      nextStreamedText,
      shouldEmitMessage: false,
    };
  }

  const rawContent =
    Array.isArray(message?.content) && message.content.length > 0
      ? message.content
      : streamedText
        ? [{ type: 'text' as const, text: streamedText }]
        : [];

  if (rawContent.length === 0) {
    return {
      effectiveContent: [],
      errorText: toUserFacingErrorText('empty_success_result'),
      nextStreamedText,
      shouldEmitMessage: false,
    };
  }

  return {
    effectiveContent: rawContent,
    nextStreamedText,
    shouldEmitMessage: rawContent.length > 0 && (message?.role === 'assistant' || !message),
  };
}
