import { describe, expect, it } from 'vitest';
import {
  sanitizeTranscriptText,
  TRANSCRIPTION_ENGLISH_OUTPUT_PROMPT,
} from '../../main/meetings/meeting-transcription-service';

describe('sanitizeTranscriptText', () => {
  it('keeps real speech', () => {
    expect(sanitizeTranscriptText('Let’s review the roadmap for Q3.')).toBe(
      'Let’s review the roadmap for Q3.'
    );
  });

  it('drops common Whisper silence hallucinations', () => {
    expect(sanitizeTranscriptText('Thank you for watching.')).toBe('');
    expect(sanitizeTranscriptText('Thanks for watching')).toBe('');
    expect(sanitizeTranscriptText('Please subscribe.')).toBe('');
    expect(sanitizeTranscriptText('[music]')).toBe('');
  });
});

describe('TRANSCRIPTION_ENGLISH_OUTPUT_PROMPT', () => {
  it('asks for English-only output with HI/GU translation', () => {
    expect(TRANSCRIPTION_ENGLISH_OUTPUT_PROMPT.toLowerCase()).toContain('english');
    expect(TRANSCRIPTION_ENGLISH_OUTPUT_PROMPT.toLowerCase()).toContain('hindi');
    expect(TRANSCRIPTION_ENGLISH_OUTPUT_PROMPT.toLowerCase()).toContain('gujarati');
    expect(TRANSCRIPTION_ENGLISH_OUTPUT_PROMPT.toLowerCase()).toContain('translate');
  });
});
