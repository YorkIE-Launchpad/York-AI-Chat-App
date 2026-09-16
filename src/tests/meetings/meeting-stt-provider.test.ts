import { describe, expect, it } from 'vitest';
import {
  MEETING_STT_PROVIDER_ENV,
  parseMeetingSttProvider,
  resolveMeetingSttProviderFromEnv,
} from '../../shared/meetings/meeting-stt-provider';

describe('meeting-stt-provider', () => {
  it('defaults to openai when unset', () => {
    expect(parseMeetingSttProvider(undefined)).toBe('openai');
    expect(parseMeetingSttProvider('')).toBe('openai');
    expect(resolveMeetingSttProviderFromEnv({})).toBe('openai');
  });

  it('accepts openai and apple case-insensitively', () => {
    expect(parseMeetingSttProvider('openai')).toBe('openai');
    expect(parseMeetingSttProvider('OPENAI')).toBe('openai');
    expect(parseMeetingSttProvider('apple')).toBe('apple');
    expect(parseMeetingSttProvider(' Apple ')).toBe('apple');
  });

  it('falls back to openai for invalid values', () => {
    expect(parseMeetingSttProvider('whisper')).toBe('openai');
    expect(parseMeetingSttProvider('local')).toBe('openai');
  });

  it('reads from env key', () => {
    expect(
      resolveMeetingSttProviderFromEnv({
        [MEETING_STT_PROVIDER_ENV]: 'apple',
      })
    ).toBe('apple');
  });
});
