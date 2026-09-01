import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LiveAssistService,
  buildLiveAssistKickoffPrompt,
  buildLiveAssistSessionTitle,
} from '../../main/meetings/live-assist-service';
import type { MeetingCaptureStatus, MeetingSession } from '../../main/meetings/meeting-types';

const mockState = vi.hoisted(() => ({
  config: {
    meetingsEnabled: true,
    meetingsRuntime: {
      realtimeTranscriptionDelay: 'low' as const,
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

const summarizeLiveAssistMeetingMock = vi.hoisted(() =>
  vi.fn(async () => 'Commitments: ship the roadmap. Follow-ups: sync with design.')
);

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    get: (key: keyof typeof mockState.config) => mockState.config[key],
    getAll: () => ({ ...mockState.config }),
  },
}));

vi.mock('../../main/meetings/live-assist-answer', () => ({
  answerLiveAssistQuestion: vi.fn(async () => 'Revenue grew 12% in Q3.'),
  summarizeLiveAssistMeeting: summarizeLiveAssistMeetingMock,
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
    (payload: {
      meetingId: string;
      segment: MeetingSession['segments'][0];
      liveTranscript: string;
    }) => void
  >();
  const speakerListeners = new Set<
    (payload: {
      meetingId: string;
      updates: Array<{ segmentId: string; speaker: string }>;
    }) => void
  >();
  const titleListeners = new Set<(payload: { meetingId: string; title: string }) => void>();
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
    onSpeakerUpdate: (
      listener: (payload: {
        meetingId: string;
        updates: Array<{ segmentId: string; speaker: string }>;
      }) => void
    ) => {
      speakerListeners.add(listener);
      return () => speakerListeners.delete(listener);
    },
    onTitleChange: (listener: (payload: { meetingId: string; title: string }) => void) => {
      titleListeners.add(listener);
      return () => titleListeners.delete(listener);
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
    emitSpeakerUpdate(payload: {
      meetingId: string;
      updates: Array<{ segmentId: string; speaker: string }>;
    }) {
      for (const listener of speakerListeners) {
        listener(payload);
      }
    },
    emitTitleChange(payload: { meetingId: string; title: string }) {
      for (const listener of titleListeners) {
        listener(payload);
      }
    },
  };

  const messages: Array<{
    id: string;
    content: Array<{ type: string; segmentId?: string; speaker?: string | null; text?: string }>;
  }> = [];

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
    publishUserText: vi.fn(),
    publishMeetingTranscript: vi.fn(
      (_sessionId: string, segment: { id: string; speaker?: string | null; text: string }) => {
        const id = `msg-${segment.id}`;
        messages.push({
          id,
          content: [
            {
              type: 'meeting_transcript',
              segmentId: segment.id,
              speaker: segment.speaker ?? null,
              text: segment.text,
            },
          ],
        });
        return id;
      }
    ),
    publishLiveAssistActivity: vi.fn(() => 'activity-msg-1'),
    updatePublishedMessage: vi.fn(
      (_sessionId: string, messageId: string, content: typeof messages[0]['content']) => {
        const existing = messages.find((message) => message.id === messageId);
        if (existing) {
          existing.content = content;
        }
      }
    ),
    getMessages: vi.fn(() => messages),
    setSessionTitle: vi.fn(() => true),
  };

  const sendToRenderer = vi.fn();

  return {
    meetingService,
    sessionManager,
    sendToRenderer,
    messages,
    setMeeting(next: MeetingSession) {
      meeting = next;
    },
    getMeeting: () => meeting,
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

  it('starts a session with a named Live Assist title', async () => {
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
    expect(deps.sessionManager.startSession).toHaveBeenCalledWith(
      'Live Assist · Weekly sync',
      expect.any(String)
    );
    expect(deps.sendToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'liveAssist.sessionStarted' })
    );
  });

  it('syncs session title when meeting title changes', async () => {
    const deps = createDeps();
    deps.setMeeting(
      createMeeting({
        title: '',
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

    deps.setMeeting({
      ...deps.getMeeting(),
      title: 'AI Roadmap Sync',
    });
    deps.meetingService.emitTitleChange({ meetingId: 'meeting-1', title: 'AI Roadmap Sync' });

    expect(deps.sessionManager.setSessionTitle).toHaveBeenCalledWith(
      'session-live-1',
      'Live Assist · AI Roadmap Sync'
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

  it('publishes transcript segments and patches speaker names later', async () => {
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

    deps.meetingService.emitSegment({
      meetingId: 'meeting-1',
      liveTranscript: 'What is our Q3 revenue?',
      segment: {
        id: 'seg-2',
        text: 'What is our Q3 revenue?',
        startedAt: Date.now(),
        endedAt: Date.now(),
        createdAt: Date.now(),
        speaker: null,
      },
    });
    await Promise.resolve();

    expect(deps.sessionManager.publishMeetingTranscript).toHaveBeenCalled();

    deps.meetingService.emitSpeakerUpdate({
      meetingId: 'meeting-1',
      updates: [{ segmentId: 'seg-2', speaker: 'Sam Patel' }],
    });

    expect(deps.sessionManager.updatePublishedMessage).toHaveBeenCalledWith(
      'session-live-1',
      'msg-seg-2',
      [
        expect.objectContaining({
          type: 'meeting_transcript',
          segmentId: 'seg-2',
          speaker: 'Sam Patel',
        }),
      ]
    );
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
    expect(buildLiveAssistSessionTitle('')).toBe('Live Assist · Zoom Meeting');
  });

  it('publishes farewell user pill and one-shot summary when capture stops', async () => {
    const deps = createDeps();
    deps.setMeeting(
      createMeeting({
        liveAssist: { enabled: true, sessionId: 'session-live-1' },
        transcriptText: 'Sam: What is the timeline?\nAlex: End of Q3.',
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
    await Promise.resolve();

    expect(deps.sessionManager.continueSession).not.toHaveBeenCalled();
    expect(deps.sessionManager.publishUserText).toHaveBeenCalledWith(
      'session-live-1',
      'Live Assist · meeting ended'
    );
    expect(summarizeLiveAssistMeetingMock).toHaveBeenCalled();
    expect(deps.sessionManager.publishAssistantText).toHaveBeenCalledWith(
      'session-live-1',
      expect.stringContaining('Commitments')
    );
  });
});
