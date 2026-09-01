import { describe, expect, it } from 'vitest';
import { parseRealtimeTranscriptionEvent } from '../../shared/meetings/realtime-transcription-events';

describe('parseRealtimeTranscriptionEvent', () => {
  it('parses transcript deltas', () => {
    const parsed = parseRealtimeTranscriptionEvent(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        delta: 'Hello',
      })
    );
    expect(parsed).toEqual({
      kind: 'delta',
      itemId: 'item_1',
      delta: 'Hello',
    });
  });

  it('parses completed transcripts', () => {
    const parsed = parseRealtimeTranscriptionEvent(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'Hello there',
      })
    );
    expect(parsed).toEqual({
      kind: 'completed',
      itemId: 'item_1',
      transcript: 'Hello there',
    });
  });

  it('ignores unknown events', () => {
    expect(
      parseRealtimeTranscriptionEvent(JSON.stringify({ type: 'session.updated' }))
    ).toBeNull();
  });
});
