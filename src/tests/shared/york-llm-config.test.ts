import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DEFAULT_YORK_LLM_BASE_URL,
  DEFAULT_YORK_LLM_MAX_CONCURRENT,
  extractYorkLlmContextWindow,
  formatYorkLlmModelName,
  isYorkLlmBaseUrl,
  isYorkLlmChatCompletionUrl,
  isYorkLlmHost,
  resolveYorkLlmApiKey,
  resolveYorkLlmBaseUrl,
  resolveYorkLlmMaxConcurrent,
  shouldMigrateToYorkLlmDefault,
  shouldSkipHubUsageForYorkLlm,
  yorkLlmSelectionPayload,
  YORK_LLM_PROMPT_TIMEOUT_MS,
  YORK_LLM_PROVIDER,
  YORK_LLM_SDK_MAX_RETRIES,
} from '../../shared/york-llm-config';

describe('york-llm-config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves default base url and max concurrent', () => {
    expect(resolveYorkLlmBaseUrl()).toBe(DEFAULT_YORK_LLM_BASE_URL);
    expect(resolveYorkLlmMaxConcurrent()).toBe(DEFAULT_YORK_LLM_MAX_CONCURRENT);
  });

  it('resolves api key from YORK_LLM_API_KEY only', () => {
    expect(resolveYorkLlmApiKey()).toBe('');
    vi.stubEnv('YORK_LLM_API_KEY', 'env-only-key');
    expect(resolveYorkLlmApiKey()).toBe('env-only-key');
  });

  it('exposes longer York activity timeout and retry budget', () => {
    expect(YORK_LLM_PROMPT_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(YORK_LLM_SDK_MAX_RETRIES).toBe(3);
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

  it('migrates only legacy system defaults to York LLM', () => {
    expect(shouldMigrateToYorkLlmDefault('')).toBe(true);
    expect(shouldMigrateToYorkLlmDefault('auto')).toBe(true);
    expect(shouldMigrateToYorkLlmDefault('openrouter/free')).toBe(true);
    expect(shouldMigrateToYorkLlmDefault('claude-sonnet-5', 'anthropic')).toBe(false);
    expect(shouldMigrateToYorkLlmDefault('gpt-5.4', 'openai')).toBe(false);
  });

  it('builds York LLM selection payload', () => {
    const payload = yorkLlmSelectionPayload('/models/test.gguf');
    expect(payload).toEqual({
      provider: YORK_LLM_PROVIDER,
      activeProfileKey: YORK_LLM_PROVIDER,
      customProtocol: 'openai',
      baseUrl: DEFAULT_YORK_LLM_BASE_URL,
      model: '/models/test.gguf',
      apiKey: '',
    });
  });
});
