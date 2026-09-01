import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runPiAiOneShotMock = vi.hoisted(() => vi.fn());

vi.mock('../../main/agent/sdk-one-shot', () => ({
  runPiAiOneShot: runPiAiOneShotMock,
}));

import type { AppConfig } from '../../main/config/config-store';
import { MemoryLLMClient } from '../../main/memory/memory-llm-client';

function makeConfig(timeoutMs: number): AppConfig {
  return {
    provider: 'custom',
    customProtocol: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    autoModelPreference: 'balanced',
    activeProfileKey: 'custom:openai',
    profiles: {},
    activeConfigSetId: 'default',
    configSets: [],
    agentCliPath: '',
    defaultWorkdir: '',
    globalSkillsPath: '',
    enableDevLogs: false,
    theme: 'light',
    sandboxEnabled: false,
    memoryEnabled: true,
    superContextMode: 'cold_intent',
    mcpWriteAccessEnabled: true,
    memoryRuntime: {
      llm: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: '',
        timeoutMs,
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
      ingestionConcurrency: 4,
      storageRoot: '',
      evalEnabled: false,
      evalWorkspaces: [],
      evalMaxRounds: 12,
      evalArtifactsRoot: '',
      promptIterationRounds: 2,
    },
    meetingsEnabled: true,
    meetingsRuntime: {
      realtimeTranscriptionDelay: 'low',
      allowChatReference: true,
      ingestIntoGlobalMemory: true,
      recentMeetingCount: 5,
      processDetectEnabled: true,
      storageRoot: '',
    },
    matterEnabled: true,
    matterRuntime: {
      enabled: true,
      windowStartHour: 8,
      windowEndHour: 21,
      intervalMinutes: 60,
      meetingsIntervalMinutes: 15,
      sensitivity: 'balanced' as const,
      maxActiveItems: 25,
      morningBriefEnabled: true,
      endOfDayWrapEnabled: false,
      autoOpenOnLaunch: false,
      sources: {
        calendar: true,
        slack: true,
        gmail: true,
        jira: true,
        hub: true,
        meeting: true,
        launchpad: true,
      },
      sourcePrompts: {
        calendar: '',
        slack: '',
        gmail: '',
        jira: '',
        hub: '',
        meeting: '',
        launchpad: '',
      },
    },
    enableThinking: false,
    profileDosPrompt: '',
    profileDontsPrompt: '',
    profileCustomPrompt: '',
    isConfigured: true,
  };
}

describe('MemoryLLMClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runPiAiOneShotMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts one-shot completions with the configured memory LLM timeout', async () => {
    let signal: AbortSignal | undefined;
    runPiAiOneShotMock.mockImplementation((_prompt, _systemPrompt, _config, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    });

    const client = new MemoryLLMClient(() => makeConfig(5000));
    const completion = client
      .complete({
        systemPrompt: 'memory system',
        userPrompt: 'memory user',
      })
      .then(
        () => null,
        (error: unknown) => error as Error
      );

    await vi.advanceTimersByTimeAsync(4999);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    const error = await completion;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Memory LLM request timed out after 5000ms');
  });
});
