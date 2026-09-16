import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAiStartMock = vi.fn();
const openAiStopMock = vi.fn();
const appleStartMock = vi.fn();
const appleStopMock = vi.fn();
const getSttProviderConfigMock = vi.fn();

vi.mock('../../renderer/meetings/openai-meeting-realtime-transcription', () => ({
  OpenAiMeetingRealtimeTranscription: class {
    currentStatus = 'idle';
    start = openAiStartMock;
    stop = openAiStopMock;
  },
}));

vi.mock('../../renderer/meetings/apple-meeting-realtime-transcription', () => ({
  AppleMeetingRealtimeTranscription: class {
    currentStatus = 'idle';
    start = appleStartMock;
    stop = appleStopMock;
  },
}));

vi.stubGlobal('window', {
  electronAPI: {
    meetings: {
      getSttProviderConfig: getSttProviderConfigMock,
    },
  },
});

describe('MeetingRealtimeTranscription facade', () => {
  beforeEach(() => {
    openAiStartMock.mockReset();
    openAiStopMock.mockReset();
    appleStartMock.mockReset();
    appleStopMock.mockReset();
    getSttProviderConfigMock.mockReset();
    vi.resetModules();
  });

  it('uses Apple when configured and supported', async () => {
    getSttProviderConfigMock.mockResolvedValue({
      requested: 'apple',
      platform: 'darwin',
      appleSupported: true,
    });
    appleStartMock.mockResolvedValue(undefined);

    const { MeetingRealtimeTranscription } =
      await import('../../renderer/meetings/MeetingRealtimeTranscription');
    const facade = new MeetingRealtimeTranscription();
    const stream = {} as MediaStream;
    await facade.start('meeting-1', stream);

    expect(appleStartMock).toHaveBeenCalledWith('meeting-1', stream);
    expect(openAiStartMock).not.toHaveBeenCalled();
  });

  it('propagates errors when Apple start fails (no OpenAI fallback)', async () => {
    getSttProviderConfigMock.mockResolvedValue({
      requested: 'apple',
      platform: 'darwin',
      appleSupported: true,
    });
    appleStartMock.mockRejectedValue(new Error('helper missing'));

    const { MeetingRealtimeTranscription } =
      await import('../../renderer/meetings/MeetingRealtimeTranscription');
    const facade = new MeetingRealtimeTranscription();
    const stream = {} as MediaStream;
    await expect(facade.start('meeting-1', stream)).rejects.toThrow(/helper missing/);
    expect(openAiStartMock).not.toHaveBeenCalled();
  });
});
