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

function resolveNotesTitle(meeting: MeetingSession, llmTitle?: string): string {
  const zoomTitle = meeting.title?.trim();
  if (zoomTitle) {
    return zoomTitle;
  }
  const generated = llmTitle?.trim();
  if (generated) {
    return generated;
  }
  return 'Untitled meeting';
}

export class MeetingNotesService {
  constructor(private readonly llm = new MemoryLLMClient()) {}

  async generateNotes(meeting: MeetingSession): Promise<MeetingNotes> {
    const zoomTitle = meeting.title?.trim();
    const transcript = meeting.transcriptText.trim();
    if (!transcript) {
      return {
        title: resolveNotesTitle(meeting),
        summary: 'No speech was transcribed for this meeting.',
        actionItems: [],
        keyTopics: [],
        generatedAt: Date.now(),
      };
    }

    const jsonKeys = zoomTitle
      ? 'summary (string), actionItems (string[]), keyTopics (string[])'
      : 'title (string, short descriptive meeting title), summary (string), actionItems (string[]), keyTopics (string[])';

    try {
      const response = await this.llm.complete({
        systemPrompt: [
          'You turn meeting transcripts into concise notes.',
          'Transcript lines may be speaker-labeled as "Name: text" — preserve who said what in action items when relevant.',
          `Return ONLY valid JSON with keys: ${jsonKeys}.`,
          'Keep summary under 180 words. Action items should be concrete and short.',
        ].join(' '),
        userPrompt: [
          zoomTitle
            ? `Meeting: ${zoomTitle}`
            : 'Meeting has no Zoom title — generate a short title from the transcript.',
          `Meeting started at: ${new Date(meeting.startedAt).toISOString()}`,
          meeting.attendees?.length ? `Attendees: ${meeting.attendees.join(', ')}` : '',
          'Transcript:',
          transcript.slice(0, 60_000),
        ]
          .filter(Boolean)
          .join('\n\n'),
        temperature: 0.2,
        maxTokens: 1200,
      });

      const parsed = extractJsonObject(response.text);
      if (parsed) {
        const llmTitle = typeof parsed.title === 'string' ? parsed.title : undefined;
        return {
          title: resolveNotesTitle(meeting, llmTitle),
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
      title: resolveNotesTitle(meeting),
      summary: transcript.slice(0, 500),
      actionItems: [],
      keyTopics: [],
      generatedAt: Date.now(),
    };
  }
}
