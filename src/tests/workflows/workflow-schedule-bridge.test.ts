import { describe, expect, it } from 'vitest';
import {
  createWorkflowScheduleBridge,
  sweepOrphanedWorkflowSchedules,
} from '../../main/workflows/workflow-schedule-bridge';
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskManager,
  ScheduledTaskUpdateInput,
} from '../../main/schedule/scheduled-task-manager';
import {
  formatWorkflowSchedulePrompt,
  WORKFLOW_SCHEDULE_PROMPT_PREFIX,
} from '../../shared/workflows';

function makeTask(
  overrides: Partial<ScheduledTask> & Pick<ScheduledTask, 'id' | 'prompt'>
): ScheduledTask {
  const now = Date.now();
  return {
    title: overrides.title ?? 'Workflow task',
    cwd: overrides.cwd ?? '/tmp',
    runAt: overrides.runAt ?? now + 60_000,
    nextRunAt: overrides.nextRunAt ?? now + 60_000,
    scheduleConfig: overrides.scheduleConfig ?? { kind: 'daily', times: ['09:00'] },
    repeatEvery: null,
    repeatUnit: null,
    enabled: overrides.enabled ?? true,
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
    clientName: null,
    clientProjectIds: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createFakeManager(): ScheduledTaskManager {
  const tasks = new Map<string, ScheduledTask>();
  let seq = 0;

  return {
    start() {},
    stop() {},
    list() {
      return Array.from(tasks.values());
    },
    get(id: string) {
      return tasks.get(id) ?? null;
    },
    create(input: ScheduledTaskCreateInput) {
      const id = `task-${++seq}`;
      const now = Date.now();
      const task = makeTask({
        id,
        title: input.title || 'Untitled',
        prompt: input.prompt,
        cwd: input.cwd,
        runAt: input.runAt,
        nextRunAt: input.nextRunAt ?? input.runAt,
        scheduleConfig: input.scheduleConfig ?? null,
        enabled: input.enabled ?? true,
        kind: input.kind ?? 'schedule',
        sessionMode: input.sessionMode ?? 'new',
        createdAt: now,
        updatedAt: now,
      });
      tasks.set(id, task);
      return task;
    },
    update(id: string, updates: ScheduledTaskUpdateInput) {
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, ...updates, updatedAt: Date.now() } as ScheduledTask;
      tasks.set(id, next);
      return next;
    },
    delete(id: string) {
      return tasks.delete(id);
    },
    toggle(id: string, enabled: boolean) {
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, enabled, updatedAt: Date.now() };
      tasks.set(id, next);
      return next;
    },
  } as ScheduledTaskManager;
}

describe('workflow-schedule-bridge', () => {
  it('removes schedule by known task id on workflow delete', async () => {
    const manager = createFakeManager();
    const workflowId = 'wf-1';
    const prompt = formatWorkflowSchedulePrompt(workflowId, 'Daily standup');
    const created = manager.create({
      title: 'Workflow: Daily standup',
      prompt,
      cwd: '/tmp',
      runAt: Date.now() + 60_000,
      scheduleConfig: { kind: 'daily', times: ['09:00'] },
    });

    const bridge = createWorkflowScheduleBridge(() => manager, () => '/tmp');
    await bridge.removeSchedulesForWorkflow(workflowId, created.id);

    expect(manager.get(created.id)).toBeNull();
    expect(manager.list()).toHaveLength(0);
  });

  it('removes schedule by prompt marker when scheduleTaskId is null', async () => {
    const manager = createFakeManager();
    const workflowId = 'wf-orphan';
    const created = manager.create({
      title: 'Workflow: Orphan',
      prompt: formatWorkflowSchedulePrompt(workflowId, 'Orphan'),
      cwd: '/tmp',
      runAt: Date.now() + 60_000,
      scheduleConfig: { kind: 'daily', times: ['10:00'] },
    });

    const bridge = createWorkflowScheduleBridge(() => manager, () => '/tmp');
    await bridge.removeSchedulesForWorkflow(workflowId, null);

    expect(manager.get(created.id)).toBeNull();
  });

  it('upserts reuses existing marker task when existingTaskId is null', async () => {
    const manager = createFakeManager();
    const workflowId = 'wf-reuse';
    const existing = manager.create({
      title: 'Workflow: Old name',
      prompt: formatWorkflowSchedulePrompt(workflowId, 'Old name'),
      cwd: '/tmp',
      runAt: Date.now() + 60_000,
      scheduleConfig: { kind: 'daily', times: ['08:00'] },
    });

    const bridge = createWorkflowScheduleBridge(() => manager, () => '/tmp');
    const taskId = await bridge.upsertCronSchedule({
      workflowId,
      workflowName: 'New name',
      times: ['11:00'],
      weekdays: [1, 2, 3, 4, 5],
      existingTaskId: null,
    });

    expect(taskId).toBe(existing.id);
    expect(manager.list()).toHaveLength(1);
    const updated = manager.get(existing.id)!;
    expect(updated.title).toContain('New name');
    expect(updated.prompt).toContain(workflowId);
    expect(updated.prompt.startsWith(WORKFLOW_SCHEDULE_PROMPT_PREFIX)).toBe(true);
  });

  it('sweep removes only schedules for missing workflows', () => {
    const manager = createFakeManager();
    const keep = manager.create({
      title: 'Workflow: Keep',
      prompt: formatWorkflowSchedulePrompt('wf-keep', 'Keep'),
      cwd: '/tmp',
      runAt: Date.now() + 60_000,
    });
    const orphan = manager.create({
      title: 'Workflow: Gone',
      prompt: formatWorkflowSchedulePrompt('wf-gone', 'Gone'),
      cwd: '/tmp',
      runAt: Date.now() + 60_000,
    });
    const normal = manager.create({
      title: 'Regular schedule',
      prompt: 'Send a standup reminder',
      cwd: '/tmp',
      runAt: Date.now() + 60_000,
    });

    const removed = sweepOrphanedWorkflowSchedules(manager, (id) => id === 'wf-keep');

    expect(removed).toEqual([orphan.id]);
    expect(manager.get(keep.id)).not.toBeNull();
    expect(manager.get(orphan.id)).toBeNull();
    expect(manager.get(normal.id)).not.toBeNull();
  });
});
