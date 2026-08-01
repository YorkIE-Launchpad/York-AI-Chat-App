import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  needsEnglishTranslation,
  normalizeTranscriptToEnglish,
} from '../../main/meetings/meeting-transcript-english';

vi.mock('../../main/auth/session', () => ({
  isAuthenticated: vi.fn(() => true),
}));

vi.mock('../../main/config/backend-auth', () => ({
  resolveBackendClientApiKey: vi.fn(async () => 'test-key'),
}));

vi.mock('../../shared/backend-config', () => ({
  BACKEND_PROXY_PLACEHOLDER_KEY: 'proxy-key',
  getBackendProxyBaseUrl: vi.fn(() => 'https://example.test/openai'),
}));

const createMock = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create: createMock,
      },
    };
  }
  return { default: OpenAI };
});

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
    createMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes English through without calling the LLM', async () => {
    await expect(normalizeTranscriptToEnglish('Ship the release tomorrow.')).resolves.toBe(
      'Ship the release tomorrow.'
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('translates Hindi via chat completions', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'We will look at the roadmap.' } }],
    });
    await expect(normalizeTranscriptToEnglish('हम रोडमैप देखेंगे')).resolves.toBe(
      'We will look at the roadmap.'
    );
    expect(createMock).toHaveBeenCalledOnce();
    const args = createMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(args.messages[1]?.content).toBe('हम रोडमैप देखेंगे');
  });
});
