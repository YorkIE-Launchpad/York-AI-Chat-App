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

export type ScopeViolationKind = 'hub' | 'launchpad' | 'connector';

export type ScopeAuditEntry = {
  timestamp: number;
  kind: ScopeViolationKind;
  action: 'blocked' | 'filtered' | 'warned';
  sessionId?: string;
  division?: string;
  toolName: string;
  attemptedResource?: string;
  message?: string;
};

const scopeAuditLog: ScopeAuditEntry[] = [];
const MAX_SCOPE_AUDIT_ENTRIES = 500;

export function recordScopeAudit(entry: Omit<ScopeAuditEntry, 'timestamp'>): void {
  scopeAuditLog.push({ ...entry, timestamp: Date.now() });
  if (scopeAuditLog.length > MAX_SCOPE_AUDIT_ENTRIES) {
    scopeAuditLog.splice(0, scopeAuditLog.length - MAX_SCOPE_AUDIT_ENTRIES);
  }
}

/** Test helper — read recent audit entries. */
export function getScopeAuditLogForTests(): readonly ScopeAuditEntry[] {
  return scopeAuditLog;
}

/** Test helper — clear audit log. */
export function clearScopeAuditLogForTests(): void {
  scopeAuditLog.length = 0;
}

export function createProjectScopeViolationReporter(options: {
  sessionId?: string | null;
  division?: Partial<SessionDivisionFields> | null;
  sendToRenderer?: ((event: ServerEvent) => void) | null;
  kind?: ScopeViolationKind;
}): OnProjectScopeViolation {
  return (info: ProjectScopeViolationNotice) => {
    const normalized = normalizeSessionDivision(options.division);
    const sessionId = info.sessionId || options.sessionId || undefined;
    const hubProjectId = info.hubProjectId ?? normalized.hubProjectId;
    const hubProjectName = info.hubProjectName ?? normalized.hubProjectName;
    const projectLabel = hubProjectName || hubProjectId || 'this project';
    const kind = options.kind ?? 'hub';

    recordScopeAudit({
      kind,
      action: 'blocked',
      sessionId,
      division: normalized.division,
      toolName: info.toolName,
      attemptedResource: info.attemptedProjectId,
      message: info.message,
    });

    logWarn(
      `[ProjectScope] Incorrect use reported (${kind})` +
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
        code: kind === 'connector' ? 'CONNECTOR_SCOPE_VIOLATION' : 'PROJECT_SCOPE_VIOLATION',
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
