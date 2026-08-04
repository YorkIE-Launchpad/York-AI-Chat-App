/**
 * Unified company project catalog (Hub allocations + LaunchPad).
 */
import { listAllocatedProjects } from '../hub/hub-allocations';
import { listLaunchPadProjects, LaunchPadProjectsError } from './launchpad-projects';
import {
  mergeHubAndLaunchpadProjects,
  type UnifiedCompanyProject,
} from '../../shared/unified-company-projects';
import { log, logWarn } from '../utils/logger';

export async function listUnifiedCompanyProjects(options?: { forceRefresh?: boolean }): Promise<{
  projects: UnifiedCompanyProject[];
  hubError?: string;
  launchpadError?: string;
}> {
  const forceRefresh = Boolean(options?.forceRefresh);
  let hubProjects: Awaited<ReturnType<typeof listAllocatedProjects>> = [];
  let launchpadProjects: Awaited<ReturnType<typeof listLaunchPadProjects>> = [];
  let hubError: string | undefined;
  let launchpadError: string | undefined;

  const [hubResult, lpResult] = await Promise.allSettled([
    listAllocatedProjects({ forceRefresh }),
    listLaunchPadProjects({ forceRefresh }),
  ]);

  if (hubResult.status === 'fulfilled') {
    hubProjects = hubResult.value;
  } else {
    hubError =
      hubResult.reason instanceof Error ? hubResult.reason.message : 'Failed to load Hub projects';
    logWarn('[UnifiedProjects] Hub list failed:', hubResult.reason);
  }

  if (lpResult.status === 'fulfilled') {
    launchpadProjects = lpResult.value;
  } else {
    launchpadError =
      lpResult.reason instanceof LaunchPadProjectsError || lpResult.reason instanceof Error
        ? lpResult.reason.message
        : 'Failed to load LaunchPad projects';
    logWarn('[UnifiedProjects] LaunchPad list failed:', lpResult.reason);
  }

  const projects = mergeHubAndLaunchpadProjects(hubProjects, launchpadProjects);
  log(
    '[UnifiedProjects] Merged',
    projects.length,
    'projects (hub:',
    hubProjects.length,
    'lp:',
    launchpadProjects.length,
    ')'
  );

  return { projects, hubError, launchpadError };
}
