/**
 * Materialize workflow cron triggers into ScheduledTaskManager entries.
 */
import {
  formatWorkflowSchedulePrompt,
  parseWorkflowSchedulePrompt,
} from '../../shared/workflows';
import type {
  ScheduledTask,
  ScheduledTaskManager,
  ScheduledTaskScheduleConfig,
  ScheduledTaskWeekday,
} from '../schedule/scheduled-task-manager';
import type { WorkflowScheduleBridge } from './workflow-service';

function estimateNextRunAt(times: string[], weekdays: number[], now = Date.now()): number {
  const sortedTimes = [...times].sort();
  const daySet = new Set(weekdays);
  const base = new Date(now);
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
    if (daySet.size > 0 && daySet.size < 7 && !daySet.has(day.getDay())) continue;
    for (const time of sortedTimes) {
      const [hour, minute] = time.split(':').map(Number);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
      const candidate = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        hour,
        minute,
        0,
        0
      ).getTime();
      if (candidate > now) return candidate;
    }
  }
  return now + 60 * 60 * 1000;
}

function toScheduleConfig(times: string[], weekdays: number[]): ScheduledTaskScheduleConfig {
  const uniqueDays = Array.from(new Set(weekdays))
    .filter((d): d is ScheduledTaskWeekday => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b);
  if (uniqueDays.length === 0 || uniqueDays.length === 7) {
    return { kind: 'daily', times };
  }
  return { kind: 'weekly', weekdays: uniqueDays, times };
}

function findTaskByWorkflowId(
  manager: ScheduledTaskManager,
  workflowId: string
): ScheduledTask | null {
  return (
    manager.list().find((task) => parseWorkflowSchedulePrompt(task.prompt) === workflowId) ?? null
  );
}

function removeWorkflowArmTask(manager: ScheduledTaskManager, taskId: string): void {
  const existing = manager.get(taskId);
  if (!existing) return;
  // Prefer disable over hard-delete so history remains; if it is only a workflow arm, delete.
  if (parseWorkflowSchedulePrompt(existing.prompt)) {
    manager.delete(taskId);
  } else {
    manager.toggle(taskId, false);
  }
}

/** Delete scheduled tasks whose workflow definition no longer exists. Returns deleted ids. */
export function sweepOrphanedWorkflowSchedules(
  manager: ScheduledTaskManager,
  workflowExists: (workflowId: string) => boolean
): string[] {
  const deleted: string[] = [];
  for (const task of manager.list()) {
    const workflowId = parseWorkflowSchedulePrompt(task.prompt);
    if (!workflowId) continue;
    if (workflowExists(workflowId)) continue;
    if (manager.delete(task.id)) deleted.push(task.id);
  }
  return deleted;
}

export function createWorkflowScheduleBridge(
  getManager: () => ScheduledTaskManager | null,
  getCwd: () => string
): WorkflowScheduleBridge {
  return {
    async upsertCronSchedule(input) {
      const manager = getManager();
      if (!manager) throw new Error('Schedule manager not ready');

      const prompt = formatWorkflowSchedulePrompt(input.workflowId, input.workflowName);
      const scheduleConfig = toScheduleConfig(input.times, input.weekdays);
      const nextRunAt = estimateNextRunAt(input.times, input.weekdays);
      const title = `Workflow: ${input.workflowName}`.slice(0, 80);
      const updateFields = {
        title,
        prompt,
        scheduleConfig,
        nextRunAt,
        runAt: nextRunAt,
        enabled: true,
        repeatEvery: null,
        repeatUnit: null,
        kind: 'schedule' as const,
        sessionMode: 'new' as const,
      };

      if (input.existingTaskId) {
        const existing = manager.get(input.existingTaskId);
        if (existing) {
          const updated = manager.update(input.existingTaskId, updateFields);
          if (updated) return updated.id;
        }
      }

      // Reuse an existing arm for this workflow when the stored task id is missing/stale.
      const byWorkflow = findTaskByWorkflowId(manager, input.workflowId);
      if (byWorkflow) {
        const updated = manager.update(byWorkflow.id, updateFields);
        if (updated) return updated.id;
      }

      const created = manager.create({
        title,
        prompt,
        cwd: getCwd(),
        runAt: nextRunAt,
        nextRunAt,
        scheduleConfig,
        enabled: true,
        kind: 'schedule',
        sessionMode: 'new',
      });
      return created.id;
    },

    async removeSchedule(taskId) {
      const manager = getManager();
      if (!manager) return;
      removeWorkflowArmTask(manager, taskId);
    },

    async removeSchedulesForWorkflow(workflowId, knownTaskId) {
      const manager = getManager();
      if (!manager) return;

      const ids = new Set<string>();
      if (knownTaskId) ids.add(knownTaskId);
      for (const task of manager.list()) {
        if (parseWorkflowSchedulePrompt(task.prompt) === workflowId) {
          ids.add(task.id);
        }
      }
      for (const id of ids) {
        removeWorkflowArmTask(manager, id);
      }
    },
  };
}
