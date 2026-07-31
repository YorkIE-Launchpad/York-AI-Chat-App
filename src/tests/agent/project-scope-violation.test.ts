import { describe, expect, it, vi } from 'vitest';
import { createProjectScopeViolationReporter } from '../../main/agent/project-scope-violation';
import type { ServerEvent } from '../../renderer/types';

describe('createProjectScopeViolationReporter', () => {
  it('emits a notice ServerEvent without treating it as a fatal error', () => {
    const sendToRenderer = vi.fn();
    const report = createProjectScopeViolationReporter({
      sessionId: 'sess-1',
      division: {
        division: 'project',
        hubProjectId: 'coach-uuid',
        hubProjectName: 'Coachmetrix',
      },
      sendToRenderer,
    });

    report({
      message: 'Incorrect use. This attempt will be reported. …',
      toolName: 'mcp__York_IE_HUB__get_project',
      attemptedProjectId: 'medical-ease-uuid',
      sessionId: 'sess-1',
      hubProjectId: 'coach-uuid',
      hubProjectName: 'Coachmetrix',
    });

    expect(sendToRenderer).toHaveBeenCalledTimes(1);
    const event = sendToRenderer.mock.calls[0]?.[0] as ServerEvent;
    expect(event).toEqual({
      type: 'notice',
      payload: {
        message: 'Incorrect use. This attempt will be reported. …',
        noticeType: 'warning',
        code: 'PROJECT_SCOPE_VIOLATION',
        projectName: 'Coachmetrix',
      },
    });
  });
});
