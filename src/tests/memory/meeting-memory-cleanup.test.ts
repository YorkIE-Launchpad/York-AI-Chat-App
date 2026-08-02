import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseInstance } from '../../main/db/database';
import { MemoryService, meetingCoreMemoryKey } from '../../main/memory/memory-service';

const mockConfigState = vi.hoisted(() => ({
  config: {
    memoryEnabled: true,
    memoryRuntime: {
      llm: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: '',
        timeoutMs: 180000,
      },
      embedding: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: 'text-embedding-3-small',
        timeoutMs: 180000,
      },
      useEmbedding: false,
      maxNavSteps: 2,
      ingestionConcurrency: 2,
      storageRoot: '',
    },
  } as Record<string, unknown>,
}));

vi.mock('electron', () => {
  const electron = {
    app: {
      isPackaged: false,
      getPath: () => '/tmp',
      getVersion: () => '0.0.0-test',
      getAppPath: () => '/tmp/york-ie-test-app',
    },
    ipcMain: { handle: () => undefined, on: () => undefined },
    shell: { openExternal: async () => true },
  };
  return { ...electron, default: electron };
});

vi.mock('../../main/config/config-store', () => {
  const configStore = {
    getAll: () => ({ ...mockConfigState.config }),
    get: (key: string) => mockConfigState.config[key],
    update: (updates: Record<string, unknown>) => {
      mockConfigState.config = { ...mockConfigState.config, ...updates };
    },
    set: (key: string, value: unknown) => {
      mockConfigState.config = { ...mockConfigState.config, [key]: value };
    },
  };
  return {
    configStore,
    PROVIDER_PRESETS: {},
  };
});

import { configStore } from '../../main/config/config-store';

describe('meeting memory cleanup', () => {
  let storageRoot: string;
  let service: MemoryService;

  beforeEach(() => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'york-ie-meeting-memory-'));
    service = new MemoryService({} as DatabaseInstance, {
      llmClient: {
        complete: async () => ({ text: '{}' }),
        embed: async () => [],
      },
    });
    configStore.update({
      memoryEnabled: true,
      memoryRuntime: {
        llm: {
          inheritFromActive: true,
          apiKey: '',
          baseUrl: '',
          model: '',
          timeoutMs: 180000,
        },
        embedding: {
          inheritFromActive: true,
          apiKey: '',
          baseUrl: '',
          model: 'text-embedding-3-small',
          timeoutMs: 180000,
        },
        useEmbedding: false,
        maxNavSteps: 2,
        ingestionConcurrency: 2,
        storageRoot: path.join(storageRoot, 'memory-root'),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('removes experience and core memories when a meeting is deleted', async () => {
    const startedAt = Date.UTC(2026, 7, 2, 12, 0, 0);
    const meeting = {
      id: 'mtg-delete-1',
      title: 'Weekly Sync',
      startedAt,
      transcriptText: 'Alice: We will ship the notes feature next week.',
      notes: {
        title: 'Weekly Sync',
        summary: 'Discussed shipping notes.',
        actionItems: ['Ship notes'],
        keyTopics: ['notes'],
      },
    };

    await service.ingestMeeting(meeting);

    const sessionId = `meeting:${meeting.id}`;
    expect(service.inspectSession(sessionId)).toBeTruthy();
    const expectedKey = meetingCoreMemoryKey('Weekly Sync', startedAt);
    const coreBefore = service.readFile(service.getOverview().coreFilePath);
    expect(coreBefore.text).toContain(`interests.${expectedKey}`);

    await service.deleteMeetingMemories(meeting);

    expect(service.inspectSession(sessionId)).toBeNull();
    const coreAfter = service.readFile(service.getOverview().coreFilePath);
    expect(coreAfter.text).not.toContain(`interests.${expectedKey}`);
    expect(service.getOverview().experienceSessionCount).toBe(0);
  });

  it('removes all meeting memories without touching other core entries', async () => {
    const startedAt = Date.UTC(2026, 7, 2, 12, 0, 0);
    await service.ingestMeeting({
      id: 'mtg-a',
      title: 'Alpha',
      startedAt,
      transcriptText: 'Talked about alpha.',
      notes: {
        title: 'Alpha',
        summary: 'Alpha summary',
        actionItems: [],
        keyTopics: ['alpha'],
      },
    });
    await service.ingestMeeting({
      id: 'mtg-b',
      title: 'Beta',
      startedAt: startedAt + 60_000,
      transcriptText: 'Talked about beta.',
      notes: {
        title: 'Beta',
        summary: 'Beta summary',
        actionItems: [],
        keyTopics: ['beta'],
      },
    });

    // Seed a non-meeting core entry directly via the same store path ingest uses.
    const overview = service.getOverview();
    const corePath = overview.coreFilePath;
    const existing = JSON.parse(fs.readFileSync(corePath, 'utf8')) as Record<string, string>;
    existing['identity.name'] = 'Jack';
    fs.writeFileSync(corePath, JSON.stringify(existing, null, 2), 'utf8');

    // Force store reload by creating a fresh service against the same root
    service = new MemoryService({} as DatabaseInstance, {
      llmClient: {
        complete: async () => ({ text: '{}' }),
        embed: async () => [],
      },
    });

    expect(service.getOverview().experienceSessionCount).toBe(2);

    const result = await service.deleteAllMeetingMemories();
    expect(result.deletedSessions).toBe(2);
    expect(service.inspectSession('meeting:mtg-a')).toBeNull();
    expect(service.inspectSession('meeting:mtg-b')).toBeNull();

    const core = service.readFile(service.getOverview().coreFilePath);
    expect(core.text).toContain('identity.name');
    expect(core.text).not.toContain('interests.meeting_');
    expect(service.getOverview().experienceSessionCount).toBe(0);
  });
});
