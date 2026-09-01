export type MeetingStatus = 'recording' | 'finalizing' | 'ready' | 'error';

export type RealtimeTranscriptionDelay =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

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

export interface MeetingLiveAssist {
  enabled: boolean;
  instructions?: string;
  sessionId?: string | null;
}

export interface MeetingStartOptions {
  liveAssist?: boolean;
  liveAssistInstructions?: string;
}

export interface MeetingLiveAssistStatus {
  meetingId: string | null;
  enabled: boolean;
  sessionId: string | null;
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
  calendarEventId?: string | null;
  liveAssist?: MeetingLiveAssist;
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
  /** True when local realtime STT is active (RTMS unavailable or timed out). */
  localSttFallbackActive?: boolean;
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
  realtimeTranscriptionDelay: RealtimeTranscriptionDelay;
  storageRoot: string;
  meetingCount: number;
  transcriptionReady: boolean;
  transcriptionReadyReason?: string;
  permissions: MeetingPermissionStatus;
  capture: MeetingCaptureStatus;
  detectedMeetingApps: string[];
  liveAssistSessionId?: string | null;
  liveAssistEnabled?: boolean;
}

export interface MeetingPromptContext {
  text: string;
  meetingIds: string[];
}
