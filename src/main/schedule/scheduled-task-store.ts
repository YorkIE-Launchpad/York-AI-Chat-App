import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance, ScheduledTaskRow } from '../db/database';
import { OPENROUTER_FREE_ROUTER_ID } from '../agent/free-model-resolve';
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskStore,
  ScheduledTaskUpdateInput,
} from './scheduled-task-manager';

export const DEFAULT_SCHEDULE_PROVIDER = 'openrouter';
export const DEFAULT_SCHEDULE_MODEL = OPENROUTER_FREE_ROUTER_ID;

export function resolveScheduleModel(
  model?: string | null,
  provider?: string | null
): { model: string; provider: string } {
  const resolvedModel = model?.trim() || DEFAULT_SCHEDULE_MODEL;
  const resolvedProvider = provider?.trim() || DEFAULT_SCHEDULE_PROVIDER;
  return { model: resolvedModel, provider: resolvedProvider };
}

export function createScheduledTaskStore(db: DatabaseInstance): ScheduledTaskStore {
  return {
    list: () => db.scheduledTasks.getAll().map(mapRowToTask),
    get: (id: string) => {
      const row = db.scheduledTasks.get(id);
      return row ? mapRowToTask(row) : null;
    },
    create: (input: ScheduledTaskCreateInput) => {
      const now = Date.now();
      const { model, provider } = resolveScheduleModel(input.model, input.provider);
      const row: ScheduledTaskRow = {
        id: uuidv4(),
        title: input.title ?? '',
        prompt: input.prompt,
        cwd: input.cwd,
        run_at: input.runAt,
        next_run_at: input.nextRunAt ?? input.runAt,
        schedule_config: input.scheduleConfig ? JSON.stringify(input.scheduleConfig) : null,
        repeat_every: input.repeatEvery ?? null,
        repeat_unit: input.repeatUnit ?? null,
        enabled: input.enabled === false ? 0 : 1,
        last_run_at: null,
        last_run_session_id: null,
        last_error: null,
        model,
        provider,
        created_at: now,
        updated_at: now,
      };
      db.scheduledTasks.create(row);
      return mapRowToTask(row);
    },
    update: (id: string, updates: ScheduledTaskUpdateInput) => {
      const mapped = mapTaskUpdatesToRow(updates);
      db.scheduledTasks.update(id, mapped);
      const row = db.scheduledTasks.get(id);
      return row ? mapRowToTask(row) : null;
    },
    delete: (id: string) => {
      const existing = db.scheduledTasks.get(id);
      if (!existing) return false;
      db.scheduledTasks.delete(id);
      return true;
    },
  };
}

function mapRowToTask(row: ScheduledTaskRow): ScheduledTask {
  const { model, provider } = resolveScheduleModel(row.model, row.provider);
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    cwd: row.cwd,
    runAt: row.run_at,
    nextRunAt: row.next_run_at,
    scheduleConfig: parseScheduleConfig(row.schedule_config),
    repeatEvery: row.repeat_every,
    repeatUnit: row.repeat_unit as ScheduledTask['repeatUnit'],
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastRunSessionId: row.last_run_session_id,
    lastError: row.last_error,
    model,
    provider,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskUpdatesToRow(updates: ScheduledTaskUpdateInput): Partial<ScheduledTaskRow> {
  const mapped: Partial<ScheduledTaskRow> = {};
  if (updates.title !== undefined) mapped.title = updates.title;
  if (updates.prompt !== undefined) mapped.prompt = updates.prompt;
  if (updates.cwd !== undefined) mapped.cwd = updates.cwd;
  if (updates.runAt !== undefined) mapped.run_at = updates.runAt;
  if (updates.nextRunAt !== undefined) mapped.next_run_at = updates.nextRunAt;
  if (updates.scheduleConfig !== undefined) {
    mapped.schedule_config = updates.scheduleConfig ? JSON.stringify(updates.scheduleConfig) : null;
  }
  if (updates.repeatEvery !== undefined) mapped.repeat_every = updates.repeatEvery;
  if (updates.repeatUnit !== undefined) mapped.repeat_unit = updates.repeatUnit;
  if (updates.enabled !== undefined) mapped.enabled = updates.enabled ? 1 : 0;
  if (updates.lastRunAt !== undefined) mapped.last_run_at = updates.lastRunAt;
  if (updates.lastRunSessionId !== undefined) mapped.last_run_session_id = updates.lastRunSessionId;
  if (updates.lastError !== undefined) mapped.last_error = updates.lastError;
  if (updates.model !== undefined || updates.provider !== undefined) {
    const resolved = resolveScheduleModel(updates.model, updates.provider);
    if (updates.model !== undefined) mapped.model = resolved.model;
    if (updates.provider !== undefined) mapped.provider = resolved.provider;
  }
  return mapped;
}

function parseScheduleConfig(value: string | null): ScheduledTask['scheduleConfig'] {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as ScheduledTask['scheduleConfig'];
  } catch {
    return null;
  }
}
