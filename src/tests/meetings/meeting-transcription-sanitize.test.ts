import { describe, expect, it } from 'vitest';
import { sanitizeTranscriptText } from '../../main/meetings/meeting-transcription-service';

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
