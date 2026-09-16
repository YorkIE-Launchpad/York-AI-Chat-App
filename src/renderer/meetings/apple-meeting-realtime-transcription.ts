import { startAppleTranscriptionPcmTap, type ApplePcmTap } from './apple-transcription-pcm';
import type { MeetingRealtimeStatus } from './meeting-realtime-types';

export class AppleMeetingRealtimeTranscription {
  private meetingId: string | null = null;
  private pcmTap: ApplePcmTap | null = null;
  private status: MeetingRealtimeStatus = 'idle';

  get currentStatus(): MeetingRealtimeStatus {
    return this.status;
  }

  async start(meetingId: string, stream: MediaStream): Promise<void> {
    if (this.meetingId === meetingId && this.pcmTap) {
      return;
    }
    await this.stop();
    this.meetingId = meetingId;
    this.status = 'connecting';

    await window.electronAPI.meetings.appleTranscription.start(meetingId);

    this.pcmTap = await startAppleTranscriptionPcmTap(stream, (pcm) => {
      window.electronAPI.meetings.appleTranscription.pushPcm(pcm);
    });
    this.status = 'streaming';
  }

  async stop(): Promise<void> {
    this.pcmTap?.stop();
    this.pcmTap = null;
    this.meetingId = null;
    this.status = 'idle';
    try {
      await window.electronAPI.meetings.appleTranscription.stop();
    } catch {
      // ignore stop errors during teardown
    }
  }
}
