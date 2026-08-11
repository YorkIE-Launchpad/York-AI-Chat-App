import { describe, expect, it, vi } from 'vitest';
import { executeScheduledTask } from '../src/main/schedule/execute-scheduled-task';
import {
  resolveScheduleWorkspaceBinding,
  scheduleBindingToStartOptions,
} from '../src/main/schedule/scheduled-task-store';
import type { ScheduledTask } from '../src/main/schedule/scheduled-task-manager';

function baseTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = Date.now();
  return {
    id: 'task-ws',
    title: '[Scheduled Task] Brief',
    prompt: 'prepare a brief',
    cwd: '/tmp/workspace',
    runAt: now,
    nextRunAt: now,
    scheduleConfig: null,
    repeatEvery: null,
    repeatUnit: null,
    enabled: true,
    lastRunAt: null,
    lastRunSessionId: null,
    lastError: null,
    model: 'openrouter/free',
    provider: 'openrouter',
    kind: 'schedule',
    sessionMode: 'new',
    boundSessionId: null,
    watchConfig: null,
    lastState: null,
    lastCheckedAt: null,
    consecutiveUnchanged: 0,
    division: 'general',
    hubProjectId: null,
    hubProjectName: null,
    launchpadProjectId: null,
    launchpadProjectName: null,
    folderId: null,
    folderName: null,
    canonicalKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('resolveScheduleWorkspaceBinding', () => {
  it('defaults to general when unset', () => {
    expect(resolveScheduleWorkspaceBinding(null).division).toBe('general');
    expect(resolveScheduleWorkspaceBinding({}).division).toBe('general');
  });

  it('keeps hub and project bindings', () => {
    expect(resolveScheduleWorkspaceBinding({ division: 'hub' }).division).toBe('hub');
    const project = resolveScheduleWorkspaceBinding({
      division: 'project',
      hubProjectId: 'hub-1',
      hubProjectName: 'Acme',
      canonicalKey: 'hub:hub-1',
    });
    expect(project.division).toBe('project');
    expect(project.hubProjectId).toBe('hub-1');
    expect(project.hubProjectName).toBe('Acme');
  });

  it('falls back invalid project without ids to general', () => {
    expect(resolveScheduleWorkspaceBinding({ division: 'project' }).division).toBe('general');
  });
});

describe('scheduleBindingToStartOptions', () => {
  it('maps task fields for startSession', () => {
    const opts = scheduleBindingToStartOptions(
      baseTask({
        division: 'folder',
        folderId: 'f1',
        folderName: 'Notes',
      })
    );
    expect(opts).toEqual({
      division: 'folder',
      hubProjectId: null,
      hubProjectName: null,
      launchpadProjectId: null,
      launchpadProjectName: null,
      folderId: 'f1',
      folderName: 'Notes',
      canonicalKey: null,
    });
  });
});

describe('executeScheduledTask workspace binding', () => {
  it('passes division options into startSession for new runs', async () => {
    const startSession = vi.fn().mockResolvedValue({ id: 'sess-1' });
    const sessionManager = {
      listSessions: () => [],
      continueSession: vi.fn(),
      startSession,
    };

    await executeScheduledTask(
      baseTask({
        division: 'hub',
        title: '[Scheduled Task] Hub pulse',
      }),
      {
        sessionManager: sessionManager as never,
        resolveTitle: async () => '[Scheduled Task] Hub pulse',
        updateTaskTitle: vi.fn(),
      }
    );

    expect(startSession).toHaveBeenCalledTimes(1);
    const options = startSession.mock.calls[0][6];
    expect(options).toMatchObject({
      model: 'openrouter/free',
      provider: 'openrouter',
      lockModel: true,
      division: 'hub',
    });
  });

  it('does not rewrite division when continuing a bound loop session', async () => {
    const startSession = vi.fn();
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const sessionManager = {
      listSessions: () => [{ id: 'bound-1' }],
      continueSession,
      startSession,
    };

    const result = await executeScheduledTask(
      baseTask({
        kind: 'loop',
        sessionMode: 'continue',
        boundSessionId: 'bound-1',
        division: 'project',
        hubProjectId: 'p1',
        hubProjectName: 'Acme',
        title: '[Scheduled Task] Loop',
      }),
      {
        sessionManager: sessionManager as never,
        resolveTitle: async () => '[Scheduled Task] Loop',
        updateTaskTitle: vi.fn(),
      }
    );

    expect(result.sessionId).toBe('bound-1');
    expect(continueSession).toHaveBeenCalledWith('bound-1', 'prepare a brief', undefined, {
      broadcastUserMessage: true,
    });
    expect(startSession).not.toHaveBeenCalled();
  });
});
