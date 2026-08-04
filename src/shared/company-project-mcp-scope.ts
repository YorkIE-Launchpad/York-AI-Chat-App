/**
 * Compose Hub hard-scope + LaunchPad soft-scope for MCP calls.
 */
import {
  applyProjectScopedMcpResultFilter,
  prepareProjectScopedMcpArgs,
  type ProjectScopedMcpPrepare,
} from './project-mcp-scope';
import { prepareLaunchpadScopedMcpArgs } from './launchpad-project-scope';
import type { SessionDivisionFields } from './workspace-division';

export function prepareCompanyProjectScopedMcpArgs(
  toolName: string,
  args: Record<string, unknown>,
  session: Partial<SessionDivisionFields> | null | undefined
): ProjectScopedMcpPrepare {
  const hub = prepareProjectScopedMcpArgs(toolName, args, session);
  if (hub.kind === 'block') {
    return hub;
  }
  const lp = prepareLaunchpadScopedMcpArgs(toolName, hub.args, session);
  if (lp.kind === 'block') {
    return {
      kind: 'block',
      message: lp.message,
      attemptedProjectId: lp.attemptedProjectId,
    };
  }
  return {
    kind: 'allow',
    args: lp.args,
    filterResult: hub.filterResult,
  };
}

export { applyProjectScopedMcpResultFilter };
