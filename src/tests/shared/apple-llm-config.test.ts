import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPLE_LLM_CONTEXT_WINDOW,
  APPLE_LLM_MODEL_ID,
  APPLE_LLM_PROVIDER,
  appleLlmSelectionPayload,
  DEFAULT_APPLE_LLM_BASE_URL,
  formatAppleLlmModelName,
  isAppleLlmBaseUrl,
  isAppleLlmSelection,
  resolveAppleLlmBaseUrl,
  resolveAppleLlmPort,
  shouldSkipHubUsageForAppleLlm,
} from '../../shared/apple-llm-config';

describe('apple-llm-config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to fm serve on loopback port 1976', () => {
    expect(resolveAppleLlmPort()).toBe(1976);
    expect(resolveAppleLlmBaseUrl()).toBe(DEFAULT_APPLE_LLM_BASE_URL);
    expect(DEFAULT_APPLE_LLM_BASE_URL).toBe('http://127.0.0.1:1976/v1');
  });

  it('honours APPLE_LLM_PORT / APPLE_LLM_BASE_URL overrides', () => {
    vi.stubEnv('APPLE_LLM_PORT', '8123');
    expect(resolveAppleLlmPort()).toBe(8123);
    expect(resolveAppleLlmBaseUrl()).toBe('http://127.0.0.1:8123/v1');
    vi.stubEnv('APPLE_LLM_BASE_URL', 'http://localhost:9000/v1/');
    expect(resolveAppleLlmBaseUrl()).toBe('http://localhost:9000/v1');
    vi.stubEnv('APPLE_LLM_PORT', 'not-a-port');
    expect(resolveAppleLlmPort()).toBe(1976);
  });

  it('detects only loopback fm base urls', () => {
    expect(isAppleLlmBaseUrl('http://127.0.0.1:1976/v1')).toBe(true);
    expect(isAppleLlmBaseUrl('http://localhost:1976/v1')).toBe(true);
    expect(isAppleLlmBaseUrl('http://127.0.0.1:11434/v1')).toBe(false); // Ollama
    expect(isAppleLlmBaseUrl('http://llm.yorkdevs.link:2222/v1')).toBe(false); // York LLM
    expect(isAppleLlmBaseUrl('http://example.com:1976/v1')).toBe(false);
    expect(isAppleLlmBaseUrl(undefined)).toBe(false);
  });

  it('detects the Apple selection only for the system model on the fm url', () => {
    expect(isAppleLlmSelection('ollama', 'http://127.0.0.1:1976/v1', APPLE_LLM_MODEL_ID)).toBe(
      true
    );
    expect(isAppleLlmSelection('ollama', 'http://127.0.0.1:1976/v1', 'llama3.2')).toBe(false);
    expect(isAppleLlmSelection('ollama', 'http://localhost:11434/v1', 'system')).toBe(false);
    expect(isAppleLlmSelection('openai', 'http://127.0.0.1:1976/v1', 'system')).toBe(false);
  });

  it('builds the selection payload on the ollama/OpenAI plumbing with a 4K window', () => {
    expect(appleLlmSelectionPayload()).toEqual({
      provider: APPLE_LLM_PROVIDER,
      activeProfileKey: APPLE_LLM_PROVIDER,
      customProtocol: 'openai',
      baseUrl: DEFAULT_APPLE_LLM_BASE_URL,
      model: 'system',
      apiKey: '',
      contextWindow: APPLE_LLM_CONTEXT_WINDOW,
      maxTokens: 512,
    });
    expect(APPLE_LLM_CONTEXT_WINDOW).toBe(4096);
  });

  it('ships a chat-first system prompt that defaults to plain text', async () => {
    const { APPLE_LLM_SYSTEM_PROMPT } = await import('../../shared/apple-llm-config');
    expect(APPLE_LLM_SYSTEM_PROMPT).toContain('Default to plain text');
    expect(APPLE_LLM_SYSTEM_PROMPT).toContain('plain text or simple Markdown');
    expect(APPLE_LLM_SYSTEM_PROMPT.length).toBeLessThan(1200); // must fit the 4K window
  });

  it('skips Hub usage and formats the display name', () => {
    expect(shouldSkipHubUsageForAppleLlm('http://127.0.0.1:1976/v1')).toBe(true);
    expect(shouldSkipHubUsageForAppleLlm('http://localhost:11434/v1')).toBe(false);
    expect(formatAppleLlmModelName('system')).toBe('Apple Local LLM (offline)');
  });
});
