export type MeetingStatus = 'recording' | 'finalizing' | 'ready' | 'error';

export type MeetingTranscriptionModel = 'gpt-4o-transcribe' | 'whisper-1';

export type MeetingSegmentSource = 'zoom-rtms' | 'local-stt';

export interface MeetingSegment {
  id: string;
  text: string;
  startedAt: number;
  endedAt: number;
  createdAt: number;
  /** Zoom display name when known. */
  speaker?: string | null;
  speakerUserId?: string | null;
  source?: MeetingSegmentSource;
}

export interface MeetingNotes {
  title: string;
  summary: string;
  actionItems: string[];
  keyTopics: string[];
  generatedAt: number;
}

export interface MeetingSession {
  id: string;
  title: string;
  status: MeetingStatus;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  segments: MeetingSegment[];
  transcriptText: string;
  notes?: MeetingNotes;
  error?: string;
  updatedAt: number;
  /** Calendar / Zoom metadata for context. */
  attendees?: string[];
  zoomMeetingUuid?: string | null;
  zoomMeetingId?: string | null;
}

export interface MeetingListItem {
  id: string;
  title: string;
  status: MeetingStatus;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  summary?: string;
  segmentCount: number;
  updatedAt: number;
}

export interface MeetingCaptureStatus {
  active: boolean;
  meetingId: string | null;
  startedAt: number | null;
  segmentCount: number;
  liveTranscript: string;
  error?: string;
}

export interface MeetingPermissionStatus {
  microphone: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
  screen: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
}

export interface MeetingOverview {
  enabled: boolean;
  /** True when Zoom OAuth connector is connected — gates auto-capture. */
  zoomConnected: boolean;
  allowChatReference: boolean;
  processDetectEnabled: boolean;
  transcriptionModel: MeetingTranscriptionModel;
  storageRoot: string;
  meetingCount: number;
  transcriptionReady: boolean;
  transcriptionReadyReason?: string;
  permissions: MeetingPermissionStatus;
  capture: MeetingCaptureStatus;
  detectedMeetingApps: string[];
}

export interface MeetingPromptContext {
  text: string;
  meetingIds: string[];
}
