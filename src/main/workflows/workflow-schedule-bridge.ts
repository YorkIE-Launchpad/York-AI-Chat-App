/**
 * Materialize workflow cron triggers into ScheduledTaskManager entries.
 */
import {
  formatWorkflowSchedulePrompt,
  parseWorkflowSchedulePrompt,
} from '../../shared/workflows';
import type {
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

      if (input.existingTaskId) {
        const existing = manager.get(input.existingTaskId);
        if (existing) {
          const updated = manager.update(input.existingTaskId, {
            title,
            prompt,
            scheduleConfig,
            nextRunAt,
            runAt: nextRunAt,
            enabled: true,
            repeatEvery: null,
            repeatUnit: null,
            kind: 'schedule',
            sessionMode: 'new',
          });
          if (updated) return updated.id;
        }
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
      const existing = manager.get(taskId);
      if (!existing) return;
      // Prefer disable over hard-delete so history remains; if it is only a workflow arm, delete.
      if (parseWorkflowSchedulePrompt(existing.prompt)) {
        manager.delete(taskId);
      } else {
        manager.toggle(taskId, false);
      }
    },
  };
}
