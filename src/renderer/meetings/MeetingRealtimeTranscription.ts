import { AppleMeetingRealtimeTranscription } from './apple-meeting-realtime-transcription';
import { OpenAiMeetingRealtimeTranscription } from './openai-meeting-realtime-transcription';
import type { MeetingRealtimeStatus } from './meeting-realtime-types';

export type { MeetingRealtimeStatus } from './meeting-realtime-types';

const openAi = new OpenAiMeetingRealtimeTranscription();
const apple = new AppleMeetingRealtimeTranscription();

export class MeetingRealtimeTranscription {
  private active: 'openai' | 'apple' | null = null;

  get currentStatus(): MeetingRealtimeStatus {
    if (this.active === 'apple') {
      return apple.currentStatus;
    }
    return openAi.currentStatus;
  }

  async start(meetingId: string, stream: MediaStream): Promise<void> {
    const config = await window.electronAPI.meetings.getSttProviderConfig();
    if (config.requested === 'apple') {
      if (!config.appleSupported) {
        throw new Error(
          'On-device Apple transcription requires macOS 26+ and the York GrowthOS speech helper.'
        );
      }
      await apple.start(meetingId, stream);
      this.active = 'apple';
      return;
    }

    await openAi.start(meetingId, stream);
    this.active = 'openai';
  }

  async stop(): Promise<void> {
    if (this.active === 'apple') {
      await apple.stop();
    } else {
      await openAi.stop();
    }
    this.active = null;
  }
}
