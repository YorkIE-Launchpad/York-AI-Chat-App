import type { MeetingSession } from '../types';
import { MeetingAudioCapture, type MeetingAudioLevelListener } from './MeetingAudioCapture';

const capture = new MeetingAudioCapture();
let startInFlight = false;
let stopInFlight = false;

export function getMeetingAudioCapture(): MeetingAudioCapture {
  return capture;
}

export function setMeetingAudioLevelListener(listener: MeetingAudioLevelListener | null): void {
  capture.setLevelListener(listener);
}

export function isMeetingAudioActive(): boolean {
  return capture.isActive;
}

export async function startMeetingCapture(title?: string): Promise<MeetingSession> {
  if (capture.isActive || startInFlight) {
    throw new Error('Meeting capture is already active');
  }
  startInFlight = true;
  try {
    const meeting = await window.electronAPI.meetings.start(title);
    await capture.start(meeting.id);
    return meeting;
  } catch (error) {
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
    await capture.stop();
    const status = await window.electronAPI.meetings.getStatus();
    if (!status.active) {
      return null;
    }
    return await window.electronAPI.meetings.stop();
  } finally {
    stopInFlight = false;
  }
}
