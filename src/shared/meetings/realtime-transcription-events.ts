/** OpenAI Realtime transcription session events (gpt-live-transcribe). */
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

export interface RealtimeTranscriptionDeltaEvent {
  type: 'conversation.item.input_audio_transcription.delta';
  item_id?: string;
  delta?: string;
}

export interface RealtimeTranscriptionCompletedEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  item_id?: string;
  transcript?: string;
}

export type ParsedRealtimeTranscriptionEvent =
  | { kind: 'delta'; itemId: string; delta: string }
  | { kind: 'completed'; itemId: string; transcript: string };

export function parseRealtimeTranscriptionEvent(raw: string): ParsedRealtimeTranscriptionEvent | null {
  let event: { type?: string; item_id?: string; delta?: string; transcript?: string };
  try {
    event = JSON.parse(raw) as {
      type?: string;
      item_id?: string;
      delta?: string;
      transcript?: string;
    };
  } catch {
    return null;
  }

  if (event.type === 'conversation.item.input_audio_transcription.delta') {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    if (!delta) return null;
    return {
      kind: 'delta',
      itemId: typeof event.item_id === 'string' ? event.item_id : '',
      delta,
    };
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
    if (!transcript) return null;
    return {
      kind: 'completed',
      itemId: typeof event.item_id === 'string' ? event.item_id : '',
      transcript,
    };
  }

  return null;
}
