import { describe, expect, it, vi } from 'vitest';
import { createDictationAppleSink } from '../../main/dictation/dictation-apple-sink';

describe('createDictationAppleSink', () => {
  it('emits partial and final IPC payloads', async () => {
    const emit = vi.fn();
    const sink = createDictationAppleSink(emit);

    await sink.appendRealtimeTranscriptPreview({
      meetingId: 'x',
      partialText: 'hello',
    });
    await sink.appendRealtimeSegment({
      meetingId: 'x',
      text: 'hello world',
    });

    expect(emit).toHaveBeenCalledWith('dictation:applePartial', { text: 'hello' });
    expect(emit).toHaveBeenCalledWith('dictation:appleFinal', { text: 'hello world' });
  });
});
