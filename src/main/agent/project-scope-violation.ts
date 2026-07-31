/**
 * Report Project workspace scope violations (incorrect cross-project Hub access).
 */
import type { ServerEvent } from '../../renderer/types';
import type {
  OnProjectScopeViolation,
  ProjectScopeViolationNotice,
} from '../../shared/project-mcp-scope';
import {
  normalizeSessionDivision,
  type SessionDivisionFields,
} from '../../shared/workspace-division';
import { logWarn } from '../utils/logger';

export function createProjectScopeViolationReporter(options: {
  sessionId?: string | null;
  division?: Partial<SessionDivisionFields> | null;
  sendToRenderer?: ((event: ServerEvent) => void) | null;
}): OnProjectScopeViolation {
  return (info: ProjectScopeViolationNotice) => {
    const normalized = normalizeSessionDivision(options.division);
    const sessionId = info.sessionId || options.sessionId || undefined;
    const hubProjectId = info.hubProjectId ?? normalized.hubProjectId;
    const hubProjectName = info.hubProjectName ?? normalized.hubProjectName;
    const projectLabel = hubProjectName || hubProjectId || 'this project';

    logWarn(
      `[ProjectScope] Incorrect use reported` +
        (sessionId ? ` session=${sessionId}` : '') +
        (hubProjectId ? ` locked=${hubProjectId}` : '') +
        (hubProjectName ? ` name=${hubProjectName}` : '') +
        ` tool=${info.toolName}` +
        (info.attemptedProjectId ? ` attempted=${info.attemptedProjectId}` : '')
    );

    options.sendToRenderer?.({
      type: 'notice',
      payload: {
        message: info.message,
        noticeType: 'warning',
        code: 'PROJECT_SCOPE_VIOLATION',
        projectName: projectLabel,
      },
    });
  };
}

export function emitProjectScopeBlock(
  onViolation: OnProjectScopeViolation | null | undefined,
  prepared: { message: string; attemptedProjectId?: string },
  toolName: string,
  session?: Partial<SessionDivisionFields> | null,
  sessionId?: string | null
): void {
  if (!onViolation) return;
  const normalized = normalizeSessionDivision(session);
  onViolation({
    message: prepared.message,
    toolName,
    attemptedProjectId: prepared.attemptedProjectId,
    sessionId: sessionId || undefined,
    hubProjectId: normalized.hubProjectId,
    hubProjectName: normalized.hubProjectName,
  });
}
