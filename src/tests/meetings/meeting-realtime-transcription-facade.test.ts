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
    openAiStopMock.mockResolvedValue(undefined);
    appleStartMock.mockReset();
    appleStopMock.mockReset();
    appleStopMock.mockResolvedValue(undefined);
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

  it('falls back to OpenAI when Apple start fails', async () => {
    getSttProviderConfigMock.mockResolvedValue({
      requested: 'apple',
      platform: 'darwin',
      appleSupported: true,
    });
    appleStartMock.mockRejectedValue(new Error('helper missing'));
    openAiStartMock.mockResolvedValue(undefined);

    const { MeetingRealtimeTranscription } =
      await import('../../renderer/meetings/MeetingRealtimeTranscription');
    const facade = new MeetingRealtimeTranscription();
    const stream = {} as MediaStream;
    await facade.start('meeting-1', stream);

    expect(appleStopMock).toHaveBeenCalled();
    expect(openAiStartMock).toHaveBeenCalledWith('meeting-1', stream);
  });

  it('uses OpenAI when Apple is not supported but requested', async () => {
    getSttProviderConfigMock.mockResolvedValue({
      requested: 'apple',
      platform: 'darwin',
      appleSupported: false,
    });
    openAiStartMock.mockResolvedValue(undefined);

    const { MeetingRealtimeTranscription } =
      await import('../../renderer/meetings/MeetingRealtimeTranscription');
    const facade = new MeetingRealtimeTranscription();
    const stream = {} as MediaStream;
    await facade.start('meeting-1', stream);

    expect(appleStartMock).not.toHaveBeenCalled();
    expect(openAiStartMock).toHaveBeenCalledWith('meeting-1', stream);
  });
});
