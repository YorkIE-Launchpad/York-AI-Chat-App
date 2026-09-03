import { describe, expect, it } from 'vitest';
import {
  DEFAULT_YORK_LLM_BASE_URL,
  DEFAULT_YORK_LLM_MAX_CONCURRENT,
  extractYorkLlmContextWindow,
  formatYorkLlmModelName,
  isYorkLlmBaseUrl,
  isYorkLlmChatCompletionUrl,
  isYorkLlmHost,
  resolveYorkLlmBaseUrl,
  resolveYorkLlmMaxConcurrent,
  shouldSkipHubUsageForYorkLlm,
  YORK_LLM_DEFAULT_LIST_LIMIT,
  YORK_LLM_LIVE_PRUNE_KEEP_RECENT,
  YORK_LLM_PROMPT_TIMEOUT_MS,
  YORK_LLM_SDK_MAX_RETRIES,
  YORK_LLM_TOOL_RESULT_MAX_CHARS,
  YORK_LLM_TOOL_RESULT_PAGE_TARGET_CHARS,
  yorkLlmToolResultCompressOptions,
} from '../../shared/york-llm-config';

describe('york-llm-config', () => {
  it('resolves default base url and max concurrent', () => {
    expect(resolveYorkLlmBaseUrl()).toBe(DEFAULT_YORK_LLM_BASE_URL);
    expect(resolveYorkLlmMaxConcurrent()).toBe(DEFAULT_YORK_LLM_MAX_CONCURRENT);
  });

  it('exposes tighter long-run hardening budgets for York LLM', () => {
    expect(YORK_LLM_TOOL_RESULT_MAX_CHARS).toBe(25_000);
    expect(YORK_LLM_TOOL_RESULT_PAGE_TARGET_CHARS).toBe(20_000);
    expect(YORK_LLM_LIVE_PRUNE_KEEP_RECENT).toBe(2);
    expect(YORK_LLM_DEFAULT_LIST_LIMIT).toBe(25);
    expect(YORK_LLM_PROMPT_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(YORK_LLM_SDK_MAX_RETRIES).toBe(3);
    expect(yorkLlmToolResultCompressOptions()).toEqual({
      maxChars: YORK_LLM_TOOL_RESULT_MAX_CHARS,
      pageTargetChars: YORK_LLM_TOOL_RESULT_PAGE_TARGET_CHARS,
    });
  });

  it('detects york llm host and base url', () => {
    expect(isYorkLlmHost('llm.yorkdevs.link')).toBe(true);
    expect(isYorkLlmHost('api.openai.com')).toBe(false);
    expect(isYorkLlmBaseUrl('http://llm.yorkdevs.link:2222/v1')).toBe(true);
    expect(isYorkLlmBaseUrl('http://localhost:11434/v1')).toBe(false);
  });

  it('skips hub usage ingest for york llm (free, no cost tracked)', () => {
    expect(shouldSkipHubUsageForYorkLlm('http://llm.yorkdevs.link:2222/v1')).toBe(true);
    expect(shouldSkipHubUsageForYorkLlm('http://localhost:11434/v1')).toBe(false);
    expect(shouldSkipHubUsageForYorkLlm(undefined)).toBe(false);
  });

  it('detects chat completion urls', () => {
    expect(
      isYorkLlmChatCompletionUrl('http://llm.yorkdevs.link:2222/v1/chat/completions')
    ).toBe(true);
    expect(isYorkLlmChatCompletionUrl('http://llm.yorkdevs.link:2222/v1/models')).toBe(false);
    expect(isYorkLlmChatCompletionUrl('http://localhost:11434/v1/chat/completions')).toBe(false);
  });

  it('formats display name as York LLM V1', () => {
    expect(
      formatYorkLlmModelName(
        '/Users/dhavalj/models/Qwen3.6-35B-A3B/Qwen3.6-35B-A3B-UD-IQ2_M.gguf'
      )
    ).toBe('York LLM V1');
  });

  it('extracts context window from model metadata', () => {
    expect(
      extractYorkLlmContextWindow({
        id: 'model-a',
        meta: { n_ctx: 125184 },
      })
    ).toBe(125184);
    expect(extractYorkLlmContextWindow({ id: 'model-b' })).toBeUndefined();
  });
});
