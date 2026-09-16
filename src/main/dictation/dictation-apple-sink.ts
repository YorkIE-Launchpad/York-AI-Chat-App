import type { MeetingRealtimeTranscriptSink } from '../meetings/apple-meeting-transcription-service';

export const DICTATION_APPLE_SESSION_ID = 'chat-dictation';

export function createDictationAppleSink(
  emit: (channel: 'dictation:applePartial' | 'dictation:appleFinal', payload: { text: string }) => void
): MeetingRealtimeTranscriptSink {
  return {
    async appendRealtimeTranscriptPreview(payload) {
      emit('dictation:applePartial', { text: payload.partialText });
      return { accepted: true };
    },
    async appendRealtimeSegment(payload) {
      emit('dictation:appleFinal', { text: payload.text });
      return { accepted: true };
    },
  };
}
