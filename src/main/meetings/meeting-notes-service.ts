import { MemoryLLMClient } from '../memory/memory-llm-client';
import type { MeetingNotes, MeetingSession } from './meeting-types';
import { logWarn } from '../utils/logger';

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

export class MeetingNotesService {
  constructor(private readonly llm = new MemoryLLMClient()) {}

  async generateNotes(meeting: MeetingSession): Promise<MeetingNotes> {
    const transcript = meeting.transcriptText.trim();
    if (!transcript) {
      return {
        title: meeting.title || 'Untitled meeting',
        summary: 'No speech was transcribed for this meeting.',
        actionItems: [],
        keyTopics: [],
        generatedAt: Date.now(),
      };
    }

    try {
      const response = await this.llm.complete({
        systemPrompt: [
          'You turn meeting transcripts into concise notes.',
          'Return ONLY valid JSON with keys: title (string), summary (string), actionItems (string[]), keyTopics (string[]).',
          'Keep summary under 180 words. Action items should be concrete and short.',
        ].join(' '),
        userPrompt: [
          `Meeting started at: ${new Date(meeting.startedAt).toISOString()}`,
          'Transcript:',
          transcript.slice(0, 60_000),
        ].join('\n\n'),
        temperature: 0.2,
        maxTokens: 1200,
      });

      const parsed = extractJsonObject(response.text);
      if (parsed) {
        return {
          title:
            typeof parsed.title === 'string' && parsed.title.trim()
              ? parsed.title.trim()
              : meeting.title || 'Meeting notes',
          summary:
            typeof parsed.summary === 'string' && parsed.summary.trim()
              ? parsed.summary.trim()
              : transcript.slice(0, 400),
          actionItems: asStringArray(parsed.actionItems),
          keyTopics: asStringArray(parsed.keyTopics),
          generatedAt: Date.now(),
        };
      }
    } catch (error) {
      logWarn('[Meetings] Failed to generate AI notes', error);
    }

    return {
      title: meeting.title || 'Meeting notes',
      summary: transcript.slice(0, 500),
      actionItems: [],
      keyTopics: [],
      generatedAt: Date.now(),
    };
  }
}
