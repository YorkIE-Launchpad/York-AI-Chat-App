import { describe, expect, it } from 'vitest';

import {
  buildTerminalErrorEmissionDetails,
  buildTerminalErrorMessage,
  resolveAbortDisposition,
  resolveAssistantStreamErrorText,
  resolveMessageEndPayload,
  shouldPreserveExistingTrace,
  toUserFacingErrorText,
  CONTEXT_OVERFLOW_USER_MESSAGE,
  USAGE_LIMIT_USER_MESSAGE,
} from '../src/main/agent/agent-runner-message-end';

describe('resolveMessageEndPayload', () => {
  it('falls back to accumulated streamed text when message_end content is empty', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: 'streamed fallback',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([{ type: 'text', text: 'streamed fallback' }]);
  });

  it('surfaces user-facing error text when message_end stops with error', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'first_response_timeout',
      },
      streamedText: 'partial text',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.shouldEmitMessage).toBe(false);
    expect(result.effectiveContent).toEqual([]);
    expect(result.errorText).toBe(
      'Model response timed out: no upstream response for a long time. Please retry later or check the current model/gateway load.'
    );
  });

  it('surfaces empty_success_result when message_end has no content and no streamed fallback', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: '',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.shouldEmitMessage).toBe(false);
    expect(result.effectiveContent).toEqual([]);
    expect(result.errorText).toBe(
      'The model returned an empty success result. The current model or gateway may have compatibility issues. Please retry or switch protocols.'
    );
  });

  it('preserves literal <think> in text as-is (never parsed)', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Use <think>reasoning</think> to think' }],
        stopReason: 'stop',
      },
      streamedText: '',
    });

    expect(result.effectiveContent).toEqual([
      { type: 'text', text: 'Use <think>reasoning</think> to think' },
    ]);
  });

  it('preserves literal <think> in thinking block content (reasoning field mentions <think>)', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'The user asks about <think> and </think> tags and what they mean.',
          },
          { type: 'text', text: 'The <think> tag wraps reasoning.' },
        ],
        stopReason: 'stop',
      },
      streamedText: '',
    });

    expect(result.effectiveContent).toEqual([
      {
        type: 'thinking',
        thinking: 'The user asks about <think> and </think> tags and what they mean.',
      },
      { type: 'text', text: 'The <think> tag wraps reasoning.' },
    ]);
  });

  it('preserves literal <think> in streamedText when message content is empty (Ollama streaming fallback)', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: 'The <think> tag is used for reasoning, not <think>actual reasoning</think>.',
    });

    expect(result.effectiveContent).toEqual([
      {
        type: 'text',
        text: 'The <think> tag is used for reasoning, not <think>actual reasoning</think>.',
      },
    ]);
  });
});

describe('toUserFacingErrorText', () => {
  it('maps 400 / bad request to configuration hint', () => {
    const result = toUserFacingErrorText('HTTP 400: bad request - ROLE_UNSPECIFIED');
    expect(result).toContain('Request rejected by upstream (400)');
    expect(result).toContain('Original error:');
    expect(result).toContain('ROLE_UNSPECIFIED');
  });

  it('maps invalid request to configuration hint', () => {
    const result = toUserFacingErrorText('invalid request: unsupported parameter "store"');
    expect(result).toContain('Request rejected by upstream (400)');
    expect(result).toContain('Original error:');
  });

  it('maps Anthropic-style 400 usage-limit errors to contact-admin copy', () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC."},"request_id":"req_011CdGynYhzSgVkKGN7UcJf9"}';
    const result = toUserFacingErrorText(raw);
    expect(result).toBe(USAGE_LIMIT_USER_MESSAGE);
    expect(result).not.toContain('model/protocol configuration');
    expect(result).not.toContain('Original error:');
  });

  it('maps Anthropic-style 400 prompt-too-long errors to context overflow copy', () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1047685 tokens > 1000000 maximum"},"request_id":"req_011CdNYPc9aou912k6HGqsER"}';
    const result = toUserFacingErrorText(raw);
    expect(result).toBe(CONTEXT_OVERFLOW_USER_MESSAGE);
    expect(result).not.toContain('model/protocol configuration');
    expect(result).not.toContain('Original error:');
  });

  it('maps bare HTTP 413 to context overflow copy (not config hint)', () => {
    expect(toUserFacingErrorText('413')).toBe(CONTEXT_OVERFLOW_USER_MESSAGE);
    expect(toUserFacingErrorText('Error: 413')).toBe(CONTEXT_OVERFLOW_USER_MESSAGE);
    expect(toUserFacingErrorText('413 Payload Too Large')).toBe(CONTEXT_OVERFLOW_USER_MESSAGE);
  });

  it('maps context overflow recovery failure to context overflow copy', () => {
    expect(
      toUserFacingErrorText(
        'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.'
      )
    ).toBe(CONTEXT_OVERFLOW_USER_MESSAGE);
  });

  it('maps quota exceeded without status code to contact-admin copy', () => {
    expect(toUserFacingErrorText('quota exceeded for this organization')).toBe(
      USAGE_LIMIT_USER_MESSAGE
    );
  });

  it('maps regain access without status code to contact-admin copy', () => {
    expect(toUserFacingErrorText('You will regain access on 2026-08-01')).toBe(
      USAGE_LIMIT_USER_MESSAGE
    );
  });

  it('maps OpenRouter 402 credit errors to contact-admin copy without provider details', () => {
    const raw =
      "402 This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 800. To increase, visit https://openrouter.ai/workspaces/default/keys/a95827fde3abfee736e0df5301661c52d6b58fc66af4bf00dbb908fc205750fb and adjust the key's total limit";
    const result = toUserFacingErrorText(raw);
    expect(result).toBe(USAGE_LIMIT_USER_MESSAGE);
    expect(result).not.toContain('openrouter.ai');
    expect(result).not.toContain(
      'a95827fde3abfee736e0df5301661c52d6b58fc66af4bf00dbb908fc205750fb'
    );
    expect(result).not.toContain('Original error:');
    expect(result).not.toContain('check your configuration');
  });

  it('maps insufficient credits without status code to contact-admin copy', () => {
    expect(toUserFacingErrorText('insufficient credits for this request')).toBe(
      USAGE_LIMIT_USER_MESSAGE
    );
  });

  it('maps 401 to authentication hint', () => {
    const result = toUserFacingErrorText('Error 401: Unauthorized');
    expect(result).toContain('Authentication failed');
    expect(result).toContain('API key');
    expect(result).toContain('Original error:');
  });

  it('maps 429 / rate limit to throttle hint', () => {
    const result = toUserFacingErrorText('429 Too Many Requests - rate limit exceeded');
    expect(result).toContain('Rate limited (429)');
    expect(result).toContain('Original error:');
  });

  it('passes through unknown errors unchanged', () => {
    const raw = 'some obscure upstream error';
    expect(toUserFacingErrorText(raw)).toBe(raw);
  });

  it('still maps first_response_timeout correctly (regression)', () => {
    expect(toUserFacingErrorText('first_response_timeout')).toBe(
      'Model response timed out: no upstream response for a long time. Please retry later or check the current model/gateway load.'
    );
  });

  it('maps 5xx server errors to upstream service hint', () => {
    const result = toUserFacingErrorText('HTTP 502: Bad Gateway');
    expect(result).toContain('Upstream service error');
    expect(result).toContain('Original error:');
    expect(result).toContain('502');
  });

  it('maps "server error" to upstream service hint', () => {
    const result = toUserFacingErrorText('internal server error');
    expect(result).toContain('Upstream service error');
  });

  it('maps "overloaded" to upstream service hint', () => {
    const result = toUserFacingErrorText('overloaded_error');
    expect(result).toContain('Upstream service error');
  });

  it('maps "terminated" to network connection hint', () => {
    const result = toUserFacingErrorText('terminated');
    expect(result).toContain('Network connection interrupted');
    expect(result).toContain('terminated');
  });

  it('maps "connection error" to network connection hint', () => {
    const result = toUserFacingErrorText('connection error: ECONNRESET');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "fetch failed" to network connection hint', () => {
    const result = toUserFacingErrorText('fetch failed');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "other side closed" to network connection hint', () => {
    const result = toUserFacingErrorText('other side closed');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "too many requests" without status code to throttle hint', () => {
    const result = toUserFacingErrorText('too many requests');
    expect(result).toContain('Rate limited (429)');
    expect(result).toContain('Original error:');
  });

  it('maps "retry delay exceeded" to network connection hint', () => {
    const result = toUserFacingErrorText('retry delay exceeded');
    expect(result).toContain('Network connection interrupted');
  });
});

describe('resolveAssistantStreamErrorText', () => {
  it('maps provider stream errors through the user-facing formatter', () => {
    const result = resolveAssistantStreamErrorText({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gemma4:31b',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        errorMessage: 'HTTP 400: invalid request - malformed tool call JSON',
        timestamp: 0,
      },
    });

    expect(result).toContain('Request rejected by upstream (400)');
    expect(result).toContain('malformed tool call JSON');
  });

  it('falls back to the event reason when the provider omits errorMessage', () => {
    const result = resolveAssistantStreamErrorText({
      type: 'error',
      reason: 'aborted',
      error: {
        role: 'assistant',
        content: [],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gemma4:31b',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'aborted',
        timestamp: 0,
      },
    });

    expect(result).toBe('aborted');
  });

  it('defensively falls back when the provider omits the error payload entirely', () => {
    const result = resolveAssistantStreamErrorText({
      type: 'error',
      reason: 'error',
      error: undefined as never,
    });

    expect(result).toBe('error');
  });
});

describe('buildTerminalErrorMessage', () => {
  it('preserves partial streamed text before the error footer', () => {
    const result = buildTerminalErrorMessage(
      'HTTP 400: invalid request',
      'Partial analysis already streamed'
    );

    expect(result).toContain('Partial analysis already streamed');
    expect(result).toContain('**Error**: HTTP 400: invalid request');
    expect(result).toContain('_Please check your configuration and retry._');
  });

  it('uses the retry hint for non-4xx terminal errors', () => {
    const result = buildTerminalErrorMessage('connection reset');
    expect(result).toContain('_Agent is retrying automatically, please wait..._');
  });

  it('uses the admin hint for usage-limit terminal errors', () => {
    const result = buildTerminalErrorMessage(USAGE_LIMIT_USER_MESSAGE);
    expect(result).toContain(`**Error**: ${USAGE_LIMIT_USER_MESSAGE}`);
    expect(result).toContain('_Contact your admin to restore access._');
    expect(result).not.toContain('_Please check your configuration and retry._');
  });

  it('uses the admin hint for raw OpenRouter 402 credit errors', () => {
    const raw =
      "402 This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 800. To increase, visit https://openrouter.ai/workspaces/default/keys/a95827fde3abfee736e0df5301661c52d6b58fc66af4bf00dbb908fc205750fb and adjust the key's total limit";
    const sanitized = toUserFacingErrorText(raw);
    const result = buildTerminalErrorMessage(sanitized);
    expect(sanitized).toBe(USAGE_LIMIT_USER_MESSAGE);
    expect(result).toContain(`**Error**: ${USAGE_LIMIT_USER_MESSAGE}`);
    expect(result).toContain('_Contact your admin to restore access._');
    expect(result).not.toContain('openrouter.ai');
    expect(result).not.toContain('_Please check your configuration and retry._');
  });

  it('uses the compact/new-chat hint for context overflow terminal errors', () => {
    const result = buildTerminalErrorMessage(CONTEXT_OVERFLOW_USER_MESSAGE);
    expect(result).toContain(`**Error**: ${CONTEXT_OVERFLOW_USER_MESSAGE}`);
    expect(result).toContain('_Use Compact in the context bar, or start a new chat._');
    expect(result).not.toContain('_Please check your configuration and retry._');
  });

  it('uses the compact hint for raw Anthropic prompt-too-long errors', () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1047685 tokens > 1000000 maximum"},"request_id":"req_011CdNYPc9aou912k6HGqsER"}';
    const result = buildTerminalErrorMessage(raw);
    expect(result).toContain('_Use Compact in the context bar, or start a new chat._');
    expect(result).not.toContain('_Please check your configuration and retry._');
  });

  it('uses the compact hint for bare 413 errors (not configuration)', () => {
    const result = buildTerminalErrorMessage('413');
    expect(result).toContain('_Use Compact in the context bar, or start a new chat._');
    expect(result).not.toContain('_Please check your configuration and retry._');
  });
});

describe('buildTerminalErrorEmissionDetails', () => {
  it('preserves streamed partial text before the error footer', () => {
    const result = buildTerminalErrorEmissionDetails({
      errorText: 'HTTP 400: invalid request',
      streamedText: 'Partial body',
    });

    expect(result.partialText).toBe('Partial body');
    expect(result.messageText).toContain('Partial body');
    expect(result.messageText).toContain('**Error**: HTTP 400: invalid request');
  });

  it('omits empty flush fragments cleanly', () => {
    const result = buildTerminalErrorEmissionDetails({
      errorText: 'connection reset',
      streamedText: '',
    });

    expect(result.partialText).toBe('');
    expect(result.messageText).toContain('_Agent is retrying automatically, please wait..._');
  });
});

describe('resolveAbortDisposition', () => {
  it('prioritizes timeout over other abort reasons', () => {
    expect(
      resolveAbortDisposition({
        abortedByTimeout: true,
        abortedByLoopGuard: true,
        abortedByStreamError: true,
      })
    ).toBe('timeout');
  });

  it('returns stream_error when only stream-error preservation should apply', () => {
    expect(
      resolveAbortDisposition({
        abortedByTimeout: false,
        abortedByLoopGuard: false,
        abortedByStreamError: true,
      })
    ).toBe('stream_error');
  });
});

describe('shouldPreserveExistingTrace', () => {
  it('preserves the published error trace for loop guard and stream errors only', () => {
    expect(shouldPreserveExistingTrace('loop_guard')).toBe(true);
    expect(shouldPreserveExistingTrace('stream_error')).toBe(true);
    expect(shouldPreserveExistingTrace('timeout')).toBe(false);
    expect(shouldPreserveExistingTrace('user')).toBe(false);
  });
});
