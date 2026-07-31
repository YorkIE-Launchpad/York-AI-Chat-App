import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockState = vi.hoisted(() => ({
  tempRoot: '',
  zoomConnected: true,
  zoomUsingMic: true,
  probeAvailable: true,
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mockState.tempRoot || os.tmpdir(),
    getVersion: () => '1.0.0-test',
  },
  shell: {
    openExternal: vi.fn(async () => true),
  },
  desktopCapturer: {
    getSources: vi.fn(async () => []),
  },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    askForMediaAccess: async () => true,
  },
}));

vi.mock('../../main/auth/session', () => ({
  isAuthenticated: () => true,
  ensureAuthenticatedSession: async () => ({ accessToken: 't', idToken: 't' }),
  getCurrentSession: () => null,
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    get: (key: string) => {
      if (key === 'meetingsEnabled') return true;
      if (key === 'meetingsRuntime') {
        return {
          transcriptionModel: 'gpt-4o-transcribe',
          allowChatReference: true,
          ingestIntoGlobalMemory: true,
          recentMeetingCount: 5,
          processDetectEnabled: true,
          storageRoot: path.join(mockState.tempRoot, 'meetings'),
        };
      }
      return undefined;
    },
    getAll: () => ({}),
    update: () => undefined,
  },
}));

vi.mock('../../main/memory/memory-llm-client', () => ({
  MemoryLLMClient: class {
    async complete() {
      return { text: '{}' };
    }
  },
}));

vi.mock('../../main/meetings/meeting-transcription-service', () => ({
  MeetingTranscriptionService: class {
    getReadiness() {
      return { ready: true, apiKey: 'test', baseUrl: 'https://api.openai.com/v1' };
    }
    async transcribeChunk() {
      return '';
    }
  },
}));

vi.mock('../../main/connectors/connector-manager', () => ({
  connectorManager: {
    isConnected: (id: string) => (id === 'zoom' ? mockState.zoomConnected : false),
    ensureFreshAccessToken: async () => ({
      accessToken: 'zoom-token',
      accountId: 'acct',
    }),
  },
}));

vi.mock('../../main/meetings/calendar-enrichment', () => ({
  findCurrentCalendarMeeting: async () => null,
}));

vi.mock('../../main/meetings/meeting-mic-detector', () => ({
  detectMeetingApps: async () => (mockState.zoomUsingMic ? ['Zoom'] : []),
  detectZoomMicUsage: async () => ({
    probeAvailable: mockState.probeAvailable,
    zoomUsingMic: mockState.zoomUsingMic,
    mode: 'coreaudio',
    processes: mockState.zoomUsingMic ? [{ pid: 1, name: 'zoom.us' }] : [],
  }),
}));

const startParticipantRtms = vi.fn(async (_token: string, _meetingId: string) => true);

vi.mock('../../main/meetings/zoom-rtms-client', () => ({
  ZoomRtmsDesktopClient: class {
    hasReceivedSegments = false;
    async findLiveMeeting() {
      return { id: '111', uuid: 'u-111', topic: 'Live' };
    }
    async startParticipantRtms(token: string, meetingId: string) {
      return startParticipantRtms(token, meetingId);
    }
    async registerSession() {
      return true;
    }
    startPolling() {}
    stopPolling() {}
    async unregister() {}
  },
}));

import { MeetingService } from '../../main/meetings/meeting-service';

describe('MeetingService auto-start retry', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockState.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meetings-autostart-'));
    mockState.zoomConnected = true;
    mockState.zoomUsingMic = true;
    mockState.probeAvailable = true;
    startParticipantRtms.mockClear();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(mockState.tempRoot, { recursive: true, force: true });
  });

  it('emits auto-start when Zoom mic is already active on bootstrap', async () => {
    const service = new MeetingService();
    const autoStarts: Array<{ showOsNotification?: boolean } | undefined> = [];
    service.onAutoStartRequested((opts) => {
      autoStarts.push(opts);
    });

    service.syncDetectionPolling();
    await vi.waitFor(() => expect(autoStarts.length).toBeGreaterThan(0));

    expect(autoStarts[0]?.showOsNotification).toBe(true);
  });

  it('retries auto-start while Zoom mic stays active after a failed ack', async () => {
    vi.useFakeTimers();
    const service = new MeetingService();
    const autoStarts: unknown[] = [];
    service.onAutoStartRequested(() => {
      autoStarts.push(Date.now());
    });

    service.syncDetectionPolling();
    await vi.waitFor(() => expect(autoStarts.length).toBe(1));

    service.reportAutoStartResult({ ok: false, error: 'renderer not ready' });

    // Advance past AUTO_START_RETRY_MS (15s) and trigger another poll.
    await vi.advanceTimersByTimeAsync(16_000);
    // Force a poll via sync (restarts timer and polls immediately).
    service.syncDetectionPolling();
    await vi.waitFor(() => expect(autoStarts.length).toBeGreaterThanOrEqual(2));

    // Successful capture (mirrors renderer: start then ack) stops further retries.
    await service.start('Retry then start');
    service.reportAutoStartResult({ ok: true });
    const countAfterOk = autoStarts.length;
    await vi.advanceTimersByTimeAsync(20_000);
    service.syncDetectionPolling();
    await Promise.resolve();
    expect(autoStarts.length).toBe(countAfterOk);

    await service.stop();
    vi.useRealTimers();
  });

  it('clears pending auto-start when capture starts successfully', async () => {
    const service = new MeetingService();
    const autoStarts: unknown[] = [];
    service.onAutoStartRequested(() => {
      autoStarts.push(1);
    });
    service.syncDetectionPolling();
    await vi.waitFor(() => expect(autoStarts.length).toBe(1));

    await service.start('Already on Zoom');
    service.reportAutoStartResult({ ok: true });

    const count = autoStarts.length;
    service.syncDetectionPolling();
    await Promise.resolve();
    expect(autoStarts.length).toBe(count);

    await service.stop();
  });

  it('clears pending auto-start when Zoom mic is released', async () => {
    const service = new MeetingService();
    const autoStarts: unknown[] = [];
    service.onAutoStartRequested(() => {
      autoStarts.push(1);
    });
    service.syncDetectionPolling();
    await vi.waitFor(() => expect(autoStarts.length).toBe(1));

    service.reportAutoStartResult({ ok: false, error: 'fail' });
    mockState.zoomUsingMic = false;
    service.syncDetectionPolling();
    await Promise.resolve();

    const count = autoStarts.length;
    mockState.zoomUsingMic = true;
    // After mic release cleared pending, next detection should emit again as edge/first.
    service.syncDetectionPolling();
    await vi.waitFor(() => expect(autoStarts.length).toBeGreaterThan(count));
  });
});
