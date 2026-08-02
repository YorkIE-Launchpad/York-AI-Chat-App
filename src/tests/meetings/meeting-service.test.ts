import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockState = vi.hoisted(() => ({
  tempRoot: '',
  micStatus: 'granted' as 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown',
  screenStatus: 'granted' as 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown',
  config: {
    meetingsEnabled: true,
    memoryEnabled: true,
    meetingsRuntime: {
      transcriptionModel: 'gpt-4o-transcribe' as const,
      allowChatReference: true,
      ingestIntoGlobalMemory: true,
      recentMeetingCount: 5,
      processDetectEnabled: false,
      storageRoot: '',
    },
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mockState.tempRoot || os.tmpdir(),
  },
  shell: {
    openExternal: vi.fn(async () => true),
  },
  desktopCapturer: {
    getSources: vi.fn(async () => {
      mockState.screenStatus = 'granted';
      return [{ id: 'screen:0', name: 'Entire Screen' }];
    }),
  },
  systemPreferences: {
    getMediaAccessStatus: (mediaType: string) =>
      mediaType === 'screen' ? mockState.screenStatus : mockState.micStatus,
    askForMediaAccess: async () => {
      mockState.micStatus = 'granted';
      return true;
    },
  },
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    get: (key: keyof typeof mockState.config) => mockState.config[key],
    getAll: () => ({ ...mockState.config }),
    update: (updates: Partial<typeof mockState.config>) => {
      mockState.config = { ...mockState.config, ...updates };
    },
  },
}));

vi.mock('../../main/memory/memory-llm-client', () => ({
  MemoryLLMClient: class {
    async complete() {
      return {
        text: JSON.stringify({
          title: 'Sync notes',
          summary: 'Discussed launch timeline.',
          actionItems: ['Ship notes'],
          keyTopics: ['launch'],
        }),
      };
    }
  },
}));

vi.mock('../../main/meetings/meeting-transcription-service', () => ({
  MeetingTranscriptionService: class {
    getReadiness() {
      return { ready: true, apiKey: 'test', baseUrl: 'https://api.openai.com/v1' };
    }
    async transcribeChunk() {
      return 'hello from the meeting';
    }
  },
}));

vi.mock('../../main/meetings/meeting-transcript-english', () => ({
  needsEnglishTranslation: () => false,
  normalizeTranscriptToEnglish: async (text: string) => text.trim(),
}));

vi.mock('../../main/connectors/connector-manager', () => ({
  connectorManager: {
    isConnected: () => false,
    ensureFreshAccessToken: async () => {
      throw new Error('not connected');
    },
  },
}));

vi.mock('../../main/meetings/calendar-enrichment', () => ({
  findCurrentCalendarMeeting: async () => null,
}));

vi.mock('../../main/meetings/zoom-rtms-client', () => ({
  ZoomRtmsDesktopClient: class {
    hasReceivedSegments = false;
    async findLiveMeeting() {
      return null;
    }
    async startParticipantRtms() {
      return false;
    }
    async registerSession() {
      return false;
    }
    startPolling() {}
    stopPolling() {}
    async unregister() {}
  },
}));

import { MeetingService } from '../../main/meetings/meeting-service';
import { createMeetingTools } from '../../main/meetings/meeting-tools';
import { buildTranscriptText } from '../../shared/meetings/transcript-format';

describe('MeetingService', () => {
  beforeEach(() => {
    mockState.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meetings-test-'));
    mockState.micStatus = 'granted';
    mockState.screenStatus = 'granted';
    mockState.config.meetingsEnabled = true;
    mockState.config.memoryEnabled = true;
    mockState.config.meetingsRuntime = {
      transcriptionModel: 'gpt-4o-transcribe',
      allowChatReference: true,
      ingestIntoGlobalMemory: true,
      recentMeetingCount: 5,
      processDetectEnabled: false,
      storageRoot: path.join(mockState.tempRoot, 'meetings'),
    };
  });

  afterEach(() => {
    fs.rmSync(mockState.tempRoot, { recursive: true, force: true });
  });

  it('finalizes with raw transcript, auto title, and auto summary', async () => {
    const service = new MeetingService();
    const meeting = await service.start('Test meeting');
    await service.appendChunk({
      meetingId: meeting.id,
      data: Buffer.alloc(2048, 1),
      mimeType: 'audio/webm',
      rms: 0.05,
    });
    const finalized = await service.stop();
    expect(finalized?.status).toBe('ready');
    expect(finalized?.transcriptText).toContain('hello from the meeting');
    expect(finalized?.title).toBe('Sync notes');
    expect(finalized?.notes?.title).toBe('Sync notes');
    expect(finalized?.notes?.summary).toContain('launch');
    expect(finalized?.notes).toBeDefined();
  });

  it('gates chat reference when allowChatReference is false', async () => {
    const service = new MeetingService();
    expect(service.isChatReferenceAllowed()).toBe(true);
    mockState.config.meetingsRuntime.allowChatReference = false;
    expect(service.isChatReferenceAllowed()).toBe(false);
  });

  it('formats meeting for prompt without transcript by default', async () => {
    const service = new MeetingService();
    const meeting = await service.start('Test meeting');
    await service.appendChunk({
      meetingId: meeting.id,
      data: Buffer.alloc(2048, 1),
      mimeType: 'audio/webm',
      rms: 0.05,
    });
    const finalized = await service.stop();
    const withoutTranscript = service.formatMeetingForPrompt(finalized!, false);
    expect(withoutTranscript).toContain('Sync notes');
    expect(withoutTranscript).not.toContain('Transcript (speaker-labeled)');
    const withTranscript = service.formatMeetingForPrompt(finalized!, true);
    expect(withTranscript).toContain('Transcript (speaker-labeled)');
    expect(withTranscript).toContain('hello from the meeting');
  });

  it('builds speaker-labeled transcript text', () => {
    expect(
      buildTranscriptText([
        { text: 'hello', speaker: 'Alice' },
        { text: 'world', speaker: null },
      ])
    ).toBe('Alice: hello\nworld');
  });

  it('reports zoomConnected false in overview when Zoom is disconnected', async () => {
    const service = new MeetingService();
    const overview = await service.getOverview();
    expect(overview.zoomConnected).toBe(false);
  });

  it('exposes meeting_search and meeting_read tools', async () => {
    const service = new MeetingService();
    const meeting = await service.start('Tool meeting');
    await service.appendChunk({
      meetingId: meeting.id,
      data: Buffer.alloc(2048, 1),
      mimeType: 'audio/webm',
      rms: 0.05,
    });
    await service.stop();

    const tools = createMeetingTools(service);
    expect(tools.map((tool) => tool.name)).toEqual(['meeting_search', 'meeting_read']);

    const search = await (
      tools[0].execute as (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>
    )('1', { query: 'launch' });
    const searchText = search.content[0]?.text || '';
    expect(searchText).toContain(meeting.id);

    const read = await (
      tools[1].execute as (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>
    )('2', { id: meeting.id, includeTranscript: true });
    const readText = read.content[0]?.text || '';
    expect(readText).toContain('Sync notes');
    expect(readText).toContain('hello from the meeting');
  });

  async function captureAndFinalize(service: MeetingService) {
    const meeting = await service.start('Test meeting');
    await service.appendChunk({
      meetingId: meeting.id,
      data: Buffer.alloc(2048, 1),
      mimeType: 'audio/webm',
      rms: 0.05,
    });
    return service.stop();
  }

  it('ingests into global Memory when toggle is on', async () => {
    const service = new MeetingService();
    let resolveIngest: () => void = () => undefined;
    const ingestDone = new Promise<void>((resolve) => {
      resolveIngest = resolve;
    });
    const ingestMeeting = vi.fn(async () => {
      resolveIngest();
    });
    service.setMemoryService({
      isEnabled: () => true,
      ingestMeeting,
    } as never);

    const finalized = await captureAndFinalize(service);
    await ingestDone;

    expect(finalized?.status).toBe('ready');
    expect(ingestMeeting).toHaveBeenCalledTimes(1);
    expect(ingestMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        id: finalized!.id,
        notes: expect.objectContaining({
          title: 'Sync notes',
          summary: expect.stringContaining('launch'),
        }),
      })
    );
  });

  it('skips Memory ingest when ingestIntoGlobalMemory is false', async () => {
    mockState.config.meetingsRuntime.ingestIntoGlobalMemory = false;
    const service = new MeetingService();
    const ingestMeeting = vi.fn(async () => undefined);
    service.setMemoryService({
      isEnabled: () => true,
      ingestMeeting,
    } as never);

    await captureAndFinalize(service);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ingestMeeting).not.toHaveBeenCalled();
  });

  it('skips Memory ingest when memoryEnabled is false', async () => {
    mockState.config.memoryEnabled = false;
    const service = new MeetingService();
    const ingestMeeting = vi.fn(async () => undefined);
    service.setMemoryService({
      isEnabled: () => mockState.config.memoryEnabled !== false,
      ingestMeeting,
    } as never);

    await captureAndFinalize(service);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ingestMeeting).not.toHaveBeenCalled();
  });

  it('deletes related memories when deleting a meeting', async () => {
    const service = new MeetingService();
    const deleteMeetingMemories = vi.fn(async () => undefined);
    service.setMemoryService({
      isEnabled: () => true,
      ingestMeeting: vi.fn(async () => undefined),
      deleteMeetingMemories,
      deleteAllMeetingMemories: vi.fn(async () => ({ success: true, deletedSessions: 0 })),
    } as never);

    const finalized = await captureAndFinalize(service);
    expect(finalized).toBeTruthy();

    await service.delete(finalized!.id);

    expect(service.get(finalized!.id)).toBeNull();
    expect(deleteMeetingMemories).toHaveBeenCalledTimes(1);
    expect(deleteMeetingMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        id: finalized!.id,
        title: finalized!.title,
        startedAt: finalized!.startedAt,
        notes: expect.objectContaining({ title: 'Sync notes' }),
      })
    );
  });

  it('clears all meeting memories when clearing all meetings', async () => {
    const service = new MeetingService();
    const deleteAllMeetingMemories = vi.fn(async () => ({
      success: true,
      deletedSessions: 1,
    }));
    service.setMemoryService({
      isEnabled: () => true,
      ingestMeeting: vi.fn(async () => undefined),
      deleteMeetingMemories: vi.fn(async () => undefined),
      deleteAllMeetingMemories,
    } as never);

    await captureAndFinalize(service);
    const result = await service.clearAll();

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(service.list()).toHaveLength(0);
    expect(deleteAllMeetingMemories).toHaveBeenCalledTimes(1);
  });

  it('does not request screen permission when requesting capture access', async () => {
    const { desktopCapturer, shell } = await import('electron');
    vi.mocked(desktopCapturer.getSources).mockClear();
    vi.mocked(shell.openExternal).mockClear();
    mockState.micStatus = 'granted';
    mockState.screenStatus = 'denied';
    const service = new MeetingService();
    const result = await service.requestCapturePermissions();
    expect(result.requestedMicrophone).toBe(false);
    expect(result.requestedScreen).toBe(false);
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('requests microphone when mic permission is denied', async () => {
    const { shell, desktopCapturer } = await import('electron');
    vi.mocked(desktopCapturer.getSources).mockClear();
    vi.mocked(shell.openExternal).mockClear();
    mockState.micStatus = 'denied';
    mockState.screenStatus = 'granted';
    const service = new MeetingService();
    const result = await service.requestCapturePermissions();
    expect(result.requestedMicrophone).toBe(true);
    expect(result.requestedScreen).toBe(false);
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(result.permissions.microphone).toBe('granted');
  });
});
