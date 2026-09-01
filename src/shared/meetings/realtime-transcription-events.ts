/** OpenAI Realtime transcription session events (gpt-live-transcribe / gpt-realtime-whisper). */
export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

export const REALTIME_TRANSCRIPTION_PROMPT =
  'York IE meeting. Mostly English with occasional Hindi or Gujarati. Output English only. Translate any Hindi or Gujarati speech into English.';

export type RealtimeTranscriptionDelay =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export const REALTIME_TRANSCRIPTION_DELAY_OPTIONS: RealtimeTranscriptionDelay[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export type ParsedRealtimeTranscriptionEvent =
  | { kind: 'delta'; itemId: string; delta: string }
  | { kind: 'completed'; itemId: string; transcript: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readTranscriptDelta(event: Record<string, unknown>): string {
  const direct = readString(event.delta).trim();
  if (direct) return direct;
  return readString(event.text).trim();
}

function readTranscriptCompleted(event: Record<string, unknown>): string {
  const direct = readString(event.transcript).trim();
  if (direct) return direct;
  const text = readString(event.text).trim();
  if (text) return text;
  const nested = event.transcript as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object') {
    return readString(nested.text).trim();
  }
  return '';
}

function isTranscriptionDeltaType(type: string): boolean {
  return (
    type === 'conversation.item.input_audio_transcription.delta' ||
    type === 'session.input_transcript.delta' ||
    type.endsWith('.input_audio_transcription.delta')
  );
}

function isTranscriptionCompletedType(type: string): boolean {
  return (
    type === 'conversation.item.input_audio_transcription.completed' ||
    type === 'session.input_transcript.completed' ||
    type.endsWith('.input_audio_transcription.completed')
  );
}

export function parseRealtimeTranscriptionEvent(raw: string): ParsedRealtimeTranscriptionEvent | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = readString(event.type);
  if (!type) {
    return null;
  }

  const itemId = readString(event.item_id);

  if (isTranscriptionDeltaType(type)) {
    const delta = readTranscriptDelta(event);
    if (!delta) return null;
    return { kind: 'delta', itemId, delta };
  }

  if (isTranscriptionCompletedType(type)) {
    const transcript = readTranscriptCompleted(event);
    if (!transcript) return null;
    return { kind: 'completed', itemId, transcript };
  }

  return null;
}
