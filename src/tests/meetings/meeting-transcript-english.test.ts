import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  needsEnglishTranslation,
  normalizeTranscriptToEnglish,
} from '../../main/meetings/meeting-transcript-english';

vi.mock('../../main/auth/session', () => ({
  isAuthenticated: vi.fn(() => true),
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: { getAll: vi.fn(() => ({ provider: 'openai', model: 'gpt-5.4' })) },
}));

const resolveYorkConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../../main/config/york-llm-api', () => ({
  resolveYorkLlmOneShotConfig: resolveYorkConfigMock,
}));

const runPiAiOneShotMock = vi.hoisted(() => vi.fn());
vi.mock('../../main/agent/sdk-one-shot', () => ({
  runPiAiOneShot: runPiAiOneShotMock,
}));

describe('needsEnglishTranslation', () => {
  it('returns false for English', () => {
    expect(needsEnglishTranslation('Let’s review the roadmap.')).toBe(false);
  });

  it('returns true for Hindi Devanagari', () => {
    expect(needsEnglishTranslation('हम रोडमैप देखेंगे')).toBe(true);
  });

  it('returns true for Gujarati script', () => {
    expect(needsEnglishTranslation('આપણે રોડમેપ જોઈએ')).toBe(true);
  });

  it('returns false for empty', () => {
    expect(needsEnglishTranslation('   ')).toBe(false);
  });
});

describe('normalizeTranscriptToEnglish', () => {
  beforeEach(() => {
    runPiAiOneShotMock.mockReset();
    resolveYorkConfigMock.mockReset();
    resolveYorkConfigMock.mockImplementation(async (config: object) => ({
      ...config,
      provider: 'ollama',
      model: 'york-test.gguf',
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes English through without calling the LLM', async () => {
    await expect(normalizeTranscriptToEnglish('Ship the release tomorrow.')).resolves.toBe(
      'Ship the release tomorrow.'
    );
    expect(runPiAiOneShotMock).not.toHaveBeenCalled();
  });

  it('translates Hindi via York LLM', async () => {
    runPiAiOneShotMock.mockResolvedValue({ text: 'We will look at the roadmap.' });
    await expect(normalizeTranscriptToEnglish('हम रोडमैप देखेंगे')).resolves.toBe(
      'We will look at the roadmap.'
    );
    expect(runPiAiOneShotMock).toHaveBeenCalledOnce();
    const [userPrompt, , config] = runPiAiOneShotMock.mock.calls[0] ?? [];
    expect(userPrompt).toBe('हम रोडमैप देखेंगे');
    expect(config).toMatchObject({ provider: 'ollama', model: 'york-test.gguf' });
  });

  it('keeps the original text when York LLM is unavailable', async () => {
    resolveYorkConfigMock.mockRejectedValue(new Error('York LLM has no models available'));
    await expect(normalizeTranscriptToEnglish('हम रोडमैप देखेंगे')).resolves.toBe(
      'हम रोडमैप देखेंगे'
    );
    expect(runPiAiOneShotMock).not.toHaveBeenCalled();
  });
});
