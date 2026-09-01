import type { MeetingSession, MeetingStartOptions } from '../types';
import { MeetingAudioCapture, type MeetingAudioLevelListener } from './MeetingAudioCapture';

const capture = new MeetingAudioCapture();
let startInFlight = false;
let stopInFlight = false;
let localSttUnsubscribe: (() => void) | null = null;
let localSttDeactivatedUnsubscribe: (() => void) | null = null;

export function getMeetingAudioCapture(): MeetingAudioCapture {
  return capture;
}

export function setMeetingAudioLevelListener(listener: MeetingAudioLevelListener | null): void {
  capture.setLevelListener(listener);
}

export function isMeetingAudioActive(): boolean {
  return capture.isActive;
}

function clearRealtimeListeners(): void {
  if (localSttUnsubscribe) {
    localSttUnsubscribe();
    localSttUnsubscribe = null;
  }
  if (localSttDeactivatedUnsubscribe) {
    localSttDeactivatedUnsubscribe();
    localSttDeactivatedUnsubscribe = null;
  }
}

async function tryStartRealtimeTranscription(): Promise<void> {
  if (!capture.isActive) {
    return;
  }
  try {
    await capture.startRealtimeTranscription();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[Meetings] Failed to start realtime transcription', error);
    try {
      await window.electronAPI.meetings.reportCaptureError(message);
    } catch {
      // ignore secondary IPC errors
    }
  }
}

async function ensureRealtimeTranscriptionIfNeeded(): Promise<void> {
  const status = await window.electronAPI.meetings.getStatus();
  if (status.localSttFallbackActive) {
    await tryStartRealtimeTranscription();
  }
}

export async function startMeetingCapture(
  title?: string,
  options?: MeetingStartOptions
): Promise<MeetingSession> {
  if (capture.isActive || startInFlight) {
    throw new Error('Meeting capture is already active');
  }
  startInFlight = true;
  try {
    const meeting = await window.electronAPI.meetings.start(title, options);
    await capture.start(meeting.id);

    clearRealtimeListeners();
    localSttUnsubscribe = window.electronAPI.meetings.onLocalSttActivated(() => {
      void tryStartRealtimeTranscription();
    });
    localSttDeactivatedUnsubscribe = window.electronAPI.meetings.onLocalSttDeactivated(() => {
      void capture.stopRealtimeTranscription();
    });

    // Start after listeners are registered — start() may have emitted localSttActivated early.
    await ensureRealtimeTranscriptionIfNeeded();

    return meeting;
  } catch (error) {
    clearRealtimeListeners();
    await capture.stop();
    try {
      const status = await window.electronAPI.meetings.getStatus();
      if (status.active) {
        await window.electronAPI.meetings.stop();
      }
    } catch {
      // ignore cleanup errors
    }
    throw error;
  } finally {
    startInFlight = false;
  }
}

export async function stopMeetingCapture(): Promise<MeetingSession | null> {
  if (stopInFlight) {
    return null;
  }
  stopInFlight = true;
  try {
    clearRealtimeListeners();
    await capture.stop();
    return await window.electronAPI.meetings.stop();
  } finally {
    stopInFlight = false;
  }
}
