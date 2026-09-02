/**
 * Compose Hub hard-scope + LaunchPad soft-scope + connector scope for MCP calls.
 */
import { prepareConnectorScopedMcpArgs } from './connector-project-scope';
import {
  applyProjectScopedMcpResultFilter,
  prepareProjectScopedMcpArgs,
  type ProjectScopedMcpPrepare,
} from './project-mcp-scope';
import {
  applyLaunchpadScopedMcpResultFilter,
  prepareLaunchpadScopedMcpArgs,
} from './launchpad-project-scope';
import {
  emptyProjectLinkage,
  type ProjectLinkageMetadata,
} from './project-linkage-metadata';
import type { SessionDivisionFields } from './workspace-division';

export function prepareCompanyProjectScopedMcpArgs(
  toolName: string,
  args: Record<string, unknown>,
  session: Partial<SessionDivisionFields> | null | undefined,
  linkage: ProjectLinkageMetadata = emptyProjectLinkage()
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
  const connector = prepareConnectorScopedMcpArgs(toolName, lp.args, session, linkage);
  if (connector.kind === 'block') {
    return connector;
  }
  return {
    kind: 'allow',
    args: connector.args,
    filterResult: hub.filterResult || Boolean(lp.filterResult) || connector.filterResult,
  };
}

export function applyCompanyProjectScopedMcpResultFilter(
  toolName: string,
  resultText: string,
  session: Partial<SessionDivisionFields> | null | undefined
): string {
  const hubFiltered = applyProjectScopedMcpResultFilter(toolName, resultText, session);
  return applyLaunchpadScopedMcpResultFilter(toolName, hubFiltered, session);
}

/** @deprecated Use applyCompanyProjectScopedMcpResultFilter */
export { applyProjectScopedMcpResultFilter };

/** Alias for prepareCompanyProjectScopedMcpArgs */
export const prepareScopedMcpArgs = prepareCompanyProjectScopedMcpArgs;

/** Alias for applyCompanyProjectScopedMcpResultFilter */
export const applyScopedMcpResultFilter = applyCompanyProjectScopedMcpResultFilter;
