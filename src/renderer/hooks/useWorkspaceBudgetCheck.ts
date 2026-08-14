import { useEffect } from 'react';
import {
  divisionBudgetCheckKey,
  hasAiBudgetCeiling,
  hasLaunchPadBudgetCeiling,
  launchPadBudgetPercent,
  userBudgetPercentFromSnapshot,
  withResolvedActiveBudget,
  type HubUserAiBudgetSnapshot,
  type LaunchPadProjectBudget,
} from '../../shared/fe-budget-gate';
import { useAppStore } from '../store';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

/** Re-fetch personal + project AI budgets. Pass forceRefresh to bypass the main-process cache. */
export async function refreshWorkspaceBudgets(options?: {
  forceRefresh?: boolean;
}): Promise<void> {
  if (!isElectron || !window.electronAPI?.hub) return;
  const forceRefresh = Boolean(options?.forceRefresh);
  const setHubUsage = useAppStore.getState().setHubUsage;
  const division = useAppStore.getState().activeDivision;
  const prev = useAppStore.getState().hubUsage;
  const divisionKey = divisionBudgetCheckKey(division);

  let userSnap: HubUserAiBudgetSnapshot | null = null;
  let projectSnap: HubUserAiBudgetSnapshot | null = null;
  let lpBudget: LaunchPadProjectBudget | null = null;

  try {
    const userRes = await window.electronAPI.hub.getUserAiBudget(forceRefresh);
    if (userRes.success && userRes.budget) userSnap = userRes.budget;
  } catch {
    /* fall through */
  }

  if (division?.kind === 'project') {
    const hubId = division.hubProjectId?.trim();
    const lpId = division.launchpadProjectId ?? null;
    const tasks: Promise<void>[] = [];
    if (hubId) {
      tasks.push(
        (async () => {
          try {
            const res = await window.electronAPI.hub.getProjectAiBudget(hubId, forceRefresh);
            if (res.success && res.budget) projectSnap = res.budget;
          } catch {
            /* unset */
          }
        })()
      );
    }
    if (typeof lpId === 'number' && lpId > 0 && window.electronAPI.launchpad?.getProjectBudget) {
      tasks.push(
        (async () => {
          try {
            const res = await window.electronAPI.launchpad.getProjectBudget(lpId, forceRefresh);
            if (res.success && res.budget) lpBudget = res.budget;
          } catch {
            /* ignore */
          }
        })()
      );
    }
    await Promise.all(tasks);
  }

  const userPercent = userSnap ? userBudgetPercentFromSnapshot(userSnap) : null;
  let projectPercent: number | null = null;
  if (division?.kind === 'project') {
    if (hasAiBudgetCeiling(projectSnap)) {
      projectPercent = userBudgetPercentFromSnapshot(projectSnap!);
    } else if (hasLaunchPadBudgetCeiling(lpBudget)) {
      projectPercent = launchPadBudgetPercent(lpBudget);
    }
  }

  setHubUsage(
    withResolvedActiveBudget(
      {
        userBudgetPercent: userPercent,
        projectBudgetPercent: projectPercent,
        lastTurnTokens: prev?.lastTurnTokens ?? null,
        updatedAt: Date.now(),
        checkedDivisionKey: divisionKey,
      },
      division?.kind
    )
  );
}

/**
 * Fetch personal + project AI budgets once per workspace switch.
 * Live usage ingest still updates percents after each turn.
 */
export function useWorkspaceBudgetCheck() {
  const activeDivision = useAppStore((s) => s.activeDivision);
  const divisionKey = divisionBudgetCheckKey(activeDivision);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.hub) return;
    void refreshWorkspaceBudgets();
  }, [divisionKey]);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.hub?.onUsage) return;
    const off = window.electronAPI.hub.onUsage((incoming) => {
      const division = useAppStore.getState().activeDivision;
      const prev = useAppStore.getState().hubUsage;
      const projectPercent =
        division?.kind === 'project' ? incoming.projectBudgetPercent : null;
      useAppStore.getState().setHubUsage(
        withResolvedActiveBudget(
          {
            userBudgetPercent: incoming.userBudgetPercent,
            projectBudgetPercent: projectPercent,
            lastTurnTokens: incoming.lastTurnTokens ?? prev?.lastTurnTokens ?? null,
            updatedAt: incoming.updatedAt || Date.now(),
            checkedDivisionKey: prev?.checkedDivisionKey ?? divisionBudgetCheckKey(division),
          },
          division?.kind
        )
      );
    });
    return off;
  }, []);
}
