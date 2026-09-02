import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance, ScheduledTaskRow } from '../db/database';
import { OPENROUTER_FREE_ROUTER_ID } from '../agent/free-model-resolve';
import type { ScheduleSessionMode, ScheduleTaskKind, WatchConfig } from '../../shared/loop/types';
import {
  normalizeWorkflowBinding,
  workflowBindingToStartOptions,
} from '../../shared/workflows';
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

/** Normalize workspace binding fields from create/update/row payloads. */
export function resolveScheduleWorkspaceBinding(
  input?: Partial<{
    division: string | null;
    hubProjectId: string | null;
    hubProjectName: string | null;
    launchpadProjectId: number | null;
    launchpadProjectName: string | null;
    folderId: string | null;
    folderName: string | null;
    canonicalKey: string | null;
  }> | null
) {
  return normalizeWorkflowBinding({
    division: (input?.division as ScheduledTask['division']) || 'general',
    hubProjectId: input?.hubProjectId,
    hubProjectName: input?.hubProjectName,
    launchpadProjectId: input?.launchpadProjectId,
    launchpadProjectName: input?.launchpadProjectName,
    folderId: input?.folderId,
    folderName: input?.folderName,
    canonicalKey: input?.canonicalKey,
  });
}

export function scheduleBindingToStartOptions(task: ScheduledTask) {
  return workflowBindingToStartOptions(task);
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
      const kind = normalizeKind(input.kind);
      const sessionMode = input.sessionMode ?? (kind === 'loop' ? 'continue' : 'new');
      const binding = resolveScheduleWorkspaceBinding(input);
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
        kind,
        session_mode: sessionMode,
        bound_session_id: input.boundSessionId ?? null,
        watch_config: input.watchConfig ? JSON.stringify(input.watchConfig) : null,
        last_state: null,
        last_checked_at: null,
        consecutive_unchanged: 0,
        division: binding.division,
        hub_project_id: binding.hubProjectId ?? null,
        hub_project_name: binding.hubProjectName ?? null,
        launchpad_project_id: binding.launchpadProjectId ?? null,
        launchpad_project_name: binding.launchpadProjectName ?? null,
        folder_id: binding.folderId ?? null,
        folder_name: binding.folderName ?? null,
        project_canonical_key: binding.canonicalKey ?? null,
        created_at: now,
        updated_at: now,
      };
      db.scheduledTasks.create(row);
      return mapRowToTask(row);
    },
    update: (id: string, updates: ScheduledTaskUpdateInput) => {
      const existing = db.scheduledTasks.get(id);
      if (!existing) return null;
      const mapped = mapTaskUpdatesToRow(updates, existing);
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

function normalizeKind(value?: ScheduleTaskKind | null): ScheduleTaskKind {
  if (value === 'loop' || value === 'watch' || value === 'schedule') return value;
  return 'schedule';
}

function normalizeSessionMode(value?: string | null, kind?: ScheduleTaskKind): ScheduleSessionMode {
  if (value === 'continue' || value === 'new') return value;
  return kind === 'loop' ? 'continue' : 'new';
}

function mapRowToTask(row: ScheduledTaskRow): ScheduledTask {
  const { model, provider } = resolveScheduleModel(row.model, row.provider);
  const kind = normalizeKind(row.kind as ScheduleTaskKind | null);
  const binding = resolveScheduleWorkspaceBinding({
    division: row.division,
    hubProjectId: row.hub_project_id,
    hubProjectName: row.hub_project_name,
    launchpadProjectId: row.launchpad_project_id,
    launchpadProjectName: row.launchpad_project_name,
    folderId: row.folder_id,
    folderName: row.folder_name,
    canonicalKey: row.project_canonical_key,
  });
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
    kind,
    sessionMode: normalizeSessionMode(row.session_mode, kind),
    boundSessionId: row.bound_session_id,
    watchConfig: parseWatchConfig(row.watch_config),
    lastState: row.last_state,
    lastCheckedAt: row.last_checked_at,
    consecutiveUnchanged: row.consecutive_unchanged ?? 0,
    division: binding.division,
    hubProjectId: binding.hubProjectId ?? null,
    hubProjectName: binding.hubProjectName ?? null,
    launchpadProjectId: binding.launchpadProjectId ?? null,
    launchpadProjectName: binding.launchpadProjectName ?? null,
    folderId: binding.folderId ?? null,
    folderName: binding.folderName ?? null,
    canonicalKey: binding.canonicalKey ?? null,
    clientName: binding.clientName ?? null,
    clientProjectIds: binding.clientProjectIds ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskUpdatesToRow(
  updates: ScheduledTaskUpdateInput,
  existing: ScheduledTaskRow
): Partial<ScheduledTaskRow> {
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
  if (updates.kind !== undefined) mapped.kind = normalizeKind(updates.kind);
  if (updates.sessionMode !== undefined) mapped.session_mode = updates.sessionMode;
  if (updates.boundSessionId !== undefined) mapped.bound_session_id = updates.boundSessionId;
  if (updates.watchConfig !== undefined) {
    mapped.watch_config = updates.watchConfig ? JSON.stringify(updates.watchConfig) : null;
  }
  if (updates.lastState !== undefined) mapped.last_state = updates.lastState;
  if (updates.lastCheckedAt !== undefined) mapped.last_checked_at = updates.lastCheckedAt;
  if (updates.consecutiveUnchanged !== undefined) {
    mapped.consecutive_unchanged = updates.consecutiveUnchanged;
  }

  const touchesBinding =
    updates.division !== undefined ||
    updates.hubProjectId !== undefined ||
    updates.hubProjectName !== undefined ||
    updates.launchpadProjectId !== undefined ||
    updates.launchpadProjectName !== undefined ||
    updates.folderId !== undefined ||
    updates.folderName !== undefined ||
    updates.canonicalKey !== undefined;
  if (touchesBinding) {
    const binding = resolveScheduleWorkspaceBinding({
      division: updates.division ?? existing.division,
      hubProjectId:
        updates.hubProjectId !== undefined ? updates.hubProjectId : existing.hub_project_id,
      hubProjectName:
        updates.hubProjectName !== undefined ? updates.hubProjectName : existing.hub_project_name,
      launchpadProjectId:
        updates.launchpadProjectId !== undefined
          ? updates.launchpadProjectId
          : existing.launchpad_project_id,
      launchpadProjectName:
        updates.launchpadProjectName !== undefined
          ? updates.launchpadProjectName
          : existing.launchpad_project_name,
      folderId: updates.folderId !== undefined ? updates.folderId : existing.folder_id,
      folderName: updates.folderName !== undefined ? updates.folderName : existing.folder_name,
      canonicalKey:
        updates.canonicalKey !== undefined ? updates.canonicalKey : existing.project_canonical_key,
    });
    mapped.division = binding.division;
    mapped.hub_project_id = binding.hubProjectId ?? null;
    mapped.hub_project_name = binding.hubProjectName ?? null;
    mapped.launchpad_project_id = binding.launchpadProjectId ?? null;
    mapped.launchpad_project_name = binding.launchpadProjectName ?? null;
    mapped.folder_id = binding.folderId ?? null;
    mapped.folder_name = binding.folderName ?? null;
    mapped.project_canonical_key = binding.canonicalKey ?? null;
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

function parseWatchConfig(value: string | null): WatchConfig | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as WatchConfig;
  } catch {
    return null;
  }
}
