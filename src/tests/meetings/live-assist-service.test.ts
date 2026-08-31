import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LiveAssistService,
  buildLiveAssistKickoffPrompt,
} from '../../main/meetings/live-assist-service';
import type { MeetingCaptureStatus, MeetingSession } from '../../main/meetings/meeting-types';

const mockState = vi.hoisted(() => ({
  config: {
    meetingsEnabled: true,
    meetingsRuntime: {
      transcriptionModel: 'gpt-4o-transcribe' as const,
      allowChatReference: true,
      ingestIntoGlobalMemory: true,
      recentMeetingCount: 5,
      processDetectEnabled: false,
      storageRoot: '',
      liveAssistInstructions: 'Focus on client updates',
      liveAssistIntervalMs: 120_000,
    },
  },
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    get: (key: keyof typeof mockState.config) => mockState.config[key],
    getAll: () => ({ ...mockState.config }),
  },
}));

vi.mock('../../main/meetings/live-assist-answer', () => ({
  answerLiveAssistQuestion: vi.fn(async () => 'Revenue grew 12% in Q3.'),
}));

vi.mock('../../main/meetings/live-assist-question-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/meetings/live-assist-question-detect')>();
  return {
    ...actual,
    classifyLiveQuestion: vi.fn(async () => ({
      answerable: true,
      question: 'What is our Q3 revenue?',
    })),
  };
});

function createMeeting(overrides: Partial<MeetingSession> = {}): MeetingSession {
  const now = Date.now();
  return {
    id: 'meeting-1',
    title: 'Weekly sync',
    status: 'recording',
    createdAt: now,
    startedAt: now,
    segments: [],
    transcriptText: '',
    updatedAt: now,
    attendees: ['Alex'],
    calendarEventId: 'evt-123',
    liveAssist: { enabled: false, sessionId: null },
    ...overrides,
  };
}

function createDeps() {
  const statusListeners = new Set<(status: MeetingCaptureStatus) => void>();
  const segmentListeners = new Set<
    (payload: { meetingId: string; segment: MeetingSession['segments'][0]; liveTranscript: string }) => void
  >();
  let meeting = createMeeting();

  const meetingService = {
    onStatus: (listener: (status: MeetingCaptureStatus) => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onSegment: (
      listener: (payload: {
        meetingId: string;
        segment: MeetingSession['segments'][0];
        liveTranscript: string;
      }) => void
    ) => {
      segmentListeners.add(listener);
      return () => segmentListeners.delete(listener);
    },
    getCaptureStatus: () => ({
      active: Boolean(meeting.status === 'recording'),
      meetingId: meeting.status === 'recording' ? meeting.id : null,
      startedAt: meeting.startedAt,
      segmentCount: 0,
      liveTranscript: meeting.transcriptText,
    }),
    get: vi.fn(() => meeting),
    patchLiveAssist: vi.fn((_meetingId: string, patch: Partial<NonNullable<MeetingSession['liveAssist']>>) => {
      meeting = {
        ...meeting,
        liveAssist: {
          enabled: patch.enabled ?? meeting.liveAssist?.enabled ?? false,
          instructions: patch.instructions ?? meeting.liveAssist?.instructions,
          sessionId: patch.sessionId ?? meeting.liveAssist?.sessionId ?? null,
        },
      };
      return meeting;
    }),
    setLiveAssist: vi.fn((options: { enabled: boolean; instructions?: string }) => {
      meeting = {
        ...meeting,
        liveAssist: {
          enabled: options.enabled,
          instructions: options.instructions ?? meeting.liveAssist?.instructions,
          sessionId: meeting.liveAssist?.sessionId ?? null,
        },
      };
      return meeting;
    }),
    getLiveAssistStatus: vi.fn(() => ({
      meetingId: meeting.id,
      enabled: meeting.liveAssist?.enabled === true,
      sessionId: meeting.liveAssist?.sessionId ?? null,
    })),
    emitStatus(status: MeetingCaptureStatus) {
      for (const listener of statusListeners) {
        listener(status);
      }
    },
    emitSegment(payload: {
      meetingId: string;
      segment: MeetingSession['segments'][0];
      liveTranscript: string;
    }) {
      for (const listener of segmentListeners) {
        listener(payload);
      }
    },
  };

  const sessionManager = {
    startSession: vi.fn(async (title: string, prompt: string) => ({
      id: 'session-live-1',
      title,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: '',
      mountedPaths: [],
      allowedTools: [],
      memoryEnabled: true,
      _prompt: prompt,
    })),
    continueSession: vi.fn(async () => undefined),
    getSession: vi.fn(() => ({ id: 'session-live-1', status: 'idle' })),
    publishAssistantText: vi.fn(),
    publishMeetingTranscript: vi.fn(() => true),
    publishLiveAssistActivity: vi.fn(() => 'activity-msg-1'),
    updatePublishedMessage: vi.fn(),
  };

  const sendToRenderer = vi.fn();

  return {
    meetingService,
    sessionManager,
    sendToRenderer,
    setMeeting(next: MeetingSession) {
      meeting = next;
    },
  };
}

describe('LiveAssistService per-meeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start a session when live assist is off', async () => {
    const deps = createDeps();
    const service = new LiveAssistService({
      sessionManager: deps.sessionManager as never,
      meetingService: deps.meetingService as never,
      mcpManager: {} as never,
      sendToRenderer: deps.sendToRenderer,
    });
    service.attach();

    deps.meetingService.emitStatus({
      active: true,
      meetingId: 'meeting-1',
      startedAt: Date.now(),
      segmentCount: 0,
      liveTranscript: 'Alex: hello',
    });
    await Promise.resolve();

    expect(deps.sessionManager.startSession).not.toHaveBeenCalled();
  });

  it('starts a session when live assist is enabled for the meeting', async () => {
    const deps = createDeps();
    deps.setMeeting(
      createMeeting({
        liveAssist: { enabled: true, instructions: 'Focus', sessionId: null },
      })
    );
    const service = new LiveAssistService({
      sessionManager: deps.sessionManager as never,
      meetingService: deps.meetingService as never,
      mcpManager: {} as never,
      sendToRenderer: deps.sendToRenderer,
    });

    const sessionId = await service.enableForMeeting('meeting-1', { focusChat: true });
    expect(sessionId).toBe('session-live-1');
    expect(deps.sessionManager.startSession).toHaveBeenCalledTimes(1);
    expect(deps.sendToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'liveAssist.sessionStarted' })
    );
  });

  it('does not re-emit sessionStarted on repeated status ticks', async () => {
    const deps = createDeps();
    deps.setMeeting(
      createMeeting({
        liveAssist: { enabled: true, instructions: 'Focus', sessionId: 'session-live-1' },
      })
    );
    const service = new LiveAssistService({
      sessionManager: deps.sessionManager as never,
      meetingService: deps.meetingService as never,
      mcpManager: {} as never,
      sendToRenderer: deps.sendToRenderer,
    });
    service.attach();

    const status: MeetingCaptureStatus = {
      active: true,
      meetingId: 'meeting-1',
      startedAt: Date.now(),
      segmentCount: 1,
      liveTranscript: 'Alex: hello',
    };

    deps.meetingService.emitStatus(status);
    deps.meetingService.emitStatus(status);
    deps.meetingService.emitStatus(status);
    await Promise.resolve();

    expect(deps.sessionManager.startSession).not.toHaveBeenCalled();
    expect(deps.sendToRenderer).not.toHaveBeenCalled();
  });

  it('publishes transcript segments to chat', async () => {
    const deps = createDeps();
    deps.setMeeting(
      createMeeting({
        liveAssist: { enabled: true, sessionId: 'session-live-1' },
        segments: [
          {
            id: 'seg-1',
            text: 'What is our Q3 revenue?',
            startedAt: Date.now(),
            endedAt: Date.now(),
            createdAt: Date.now(),
            speaker: 'Sam',
          },
        ],
      })
    );
    const service = new LiveAssistService({
      sessionManager: deps.sessionManager as never,
      meetingService: deps.meetingService as never,
      mcpManager: {} as never,
      sendToRenderer: deps.sendToRenderer,
    });
    service.attach();
    await service.enableForMeeting('meeting-1', { focusChat: false });

    deps.meetingService.emitSegment({
      meetingId: 'meeting-1',
      liveTranscript: 'Sam: What is our Q3 revenue?',
      segment: {
        id: 'seg-2',
        text: 'Thanks everyone',
        startedAt: Date.now(),
        endedAt: Date.now(),
        createdAt: Date.now(),
        speaker: 'Alex',
      },
    });
    await Promise.resolve();

    expect(deps.sessionManager.publishMeetingTranscript).toHaveBeenCalled();
  });

  it('builds kickoff prompt for live Q&A', () => {
    const prompt = buildLiveAssistKickoffPrompt({
      meetingTitle: 'Client review',
      attendees: ['Alex'],
      prepContext: 'Prep note',
      customInstructions: 'Watch pricing',
    });
    expect(prompt).toContain('Background research');
    expect(prompt).not.toContain('subagent');
    expect(prompt).toContain('Client review');
    expect(prompt).toContain('Prep note');
  });

  it('sends farewell when capture stops', async () => {
    const deps = createDeps();
    deps.setMeeting(
      createMeeting({
        liveAssist: { enabled: true, sessionId: 'session-live-1' },
      })
    );
    const service = new LiveAssistService({
      sessionManager: deps.sessionManager as never,
      meetingService: deps.meetingService as never,
      mcpManager: {} as never,
      sendToRenderer: deps.sendToRenderer,
    });
    service.attach();
    await service.enableForMeeting('meeting-1', { focusChat: false });

    deps.meetingService.emitStatus({
      active: false,
      meetingId: null,
      startedAt: null,
      segmentCount: 0,
      liveTranscript: '',
    });
    await Promise.resolve();

    expect(deps.sessionManager.continueSession).toHaveBeenCalled();
  });
});
