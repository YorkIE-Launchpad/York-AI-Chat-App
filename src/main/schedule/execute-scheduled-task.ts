import type { SessionManager } from '../session/session-manager';
import type { ScheduledTask, ScheduledTaskRunResult } from './scheduled-task-manager';
import {
  buildScheduledTaskFallbackTitle,
  buildScheduledTaskTitle,
} from '../../shared/schedule/task-title';
import { scheduleBindingToStartOptions } from './scheduled-task-store';
import type { SessionDivisionFields } from '../../shared/workspace-division';

export interface ExecuteScheduledTaskDeps {
  sessionManager: SessionManager;
  resolveTitle: (prompt: string, cwd: string, title?: string) => Promise<string>;
  updateTaskTitle: (taskId: string, title: string) => void;
  /** Return an error message if cwd is unsupported. */
  validateCwd?: (cwd: string) => string | null;
  /** Re-validate workspace binding against current allocations before starting a session. */
  validateWorkspaceBinding?: (
    task: ScheduledTask
  ) => Promise<SessionDivisionFields>;
  /** Notify renderer of a newly created session (GUI only). */
  onSessionStarted?: (session: Awaited<ReturnType<SessionManager['startSession']>>) => void;
  /** When true, return empty sessionId (headless). */
  omitSessionId?: boolean;
}

/**
 * Runs a scheduled/loop/watch act prompt. Watch condition checks happen in ScheduledTaskManager.
 */
export async function executeScheduledTask(
  task: ScheduledTask,
  deps: ExecuteScheduledTaskDeps
): Promise<ScheduledTaskRunResult> {
  const unsupportedReason = deps.validateCwd?.(task.cwd) ?? null;
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }

  const fallbackTitle = buildScheduledTaskFallbackTitle(task.prompt);
  const needsRegeneratedTitle = !task.title?.trim() || task.title === fallbackTitle;
  const title = needsRegeneratedTitle
    ? await deps.resolveTitle(task.prompt, task.cwd, task.title)
    : buildScheduledTaskTitle(task.title);
  if (title !== task.title) {
    deps.updateTaskTitle(task.id, title);
  }

  const shouldContinue =
    (task.kind === 'loop' || task.sessionMode === 'continue') && Boolean(task.boundSessionId);

  if (shouldContinue && task.boundSessionId) {
    const sessions = deps.sessionManager.listSessions();
    const exists = sessions.some((s) => s.id === task.boundSessionId);
    if (exists) {
      await deps.sessionManager.continueSession(task.boundSessionId, task.prompt, undefined, {
        broadcastUserMessage: true,
      });
      return { sessionId: deps.omitSessionId ? '' : task.boundSessionId };
    }
  }

  const workspace = scheduleBindingToStartOptions(task);
  const validatedWorkspace = deps.validateWorkspaceBinding
    ? await deps.validateWorkspaceBinding(task)
    : workspace;
  const started = await deps.sessionManager.startSession(
    title,
    task.prompt,
    task.cwd,
    undefined,
    undefined,
    undefined,
    {
      model: task.model,
      provider: task.provider,
      lockModel: true,
      ...validatedWorkspace,
    }
  );
  deps.onSessionStarted?.(started);
  return { sessionId: deps.omitSessionId ? '' : started.id };
}
