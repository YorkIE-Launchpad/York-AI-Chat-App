/**
 * FE-owned Hub user AI budget + LaunchPad project budget gating.
 * York LLM proxy does not enforce these — the Electron client gates paid models.
 *
 * Project strategies:
 * - hub-only → Hub user AI budget (via allowed-models has_budget)
 * - launchpad-only → LaunchPad project budget alone
 * - both → Hub user budget; if over or unset, LaunchPad project budget can re-enable paid proxy
 */

export type HubAiBudgetStatus = 'ok' | 'warning' | 'over' | 'unset';

export interface HubUserAiBudgetSnapshot {
  status: HubAiBudgetStatus;
  amount: number | null;
  spent: number | null;
  remaining: number | null;
  currency: string | null;
  fiscalYearLabel: string | null;
}

export interface LaunchPadProjectBudget {
  budgetUsd: number;
  totalSpendUsd: number;
  remainingUsd: number;
  isOverBudget: boolean;
}

/** Which budget(s) gate paid York-proxy models in Project division. */
export type ProjectBudgetGateStrategy = 'hub' | 'launchpad' | 'both';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function numberField(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function booleanField(row: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function normalizeHubBudgetStatus(raw: string | null): HubAiBudgetStatus {
  if (raw === 'ok' || raw === 'warning' || raw === 'over' || raw === 'unset') return raw;
  return 'unset';
}

function hasHubProjectLink(input: {
  sources?: { hub?: boolean; launchpad?: boolean } | null;
  hubProjectId?: string | null;
}): boolean {
  if (input.sources?.hub) return true;
  return typeof input.hubProjectId === 'string' && Boolean(input.hubProjectId.trim());
}

function hasLaunchPadProjectLink(input: {
  sources?: { hub?: boolean; launchpad?: boolean } | null;
  launchpadProjectId?: number | null;
}): boolean {
  if (input.sources?.launchpad) return true;
  return (
    typeof input.launchpadProjectId === 'number' &&
    Number.isFinite(input.launchpadProjectId) &&
    input.launchpadProjectId > 0
  );
}

/** Parse Hub GET /api/users/:email/ai-budget envelope (or bare data). */
export function parseHubUserAiBudget(payload: unknown): HubUserAiBudgetSnapshot {
  const root = asRecord(payload) || {};
  const data = asRecord(root.data) || root;
  return {
    status: normalizeHubBudgetStatus(stringField(data, 'status')),
    amount: numberField(data, 'amount'),
    spent: numberField(data, 'spent'),
    remaining: numberField(data, 'remaining'),
    currency: stringField(data, 'currency'),
    fiscalYearLabel: stringField(data, 'fiscal_year_label', 'fiscalYearLabel'),
  };
}

/** Parse LaunchPad GET /api/projects/:projectId/budget. */
export function parseLaunchPadProjectBudget(payload: unknown): LaunchPadProjectBudget {
  const root = asRecord(payload) || {};
  const data = asRecord(root.data) || root;
  const budgetUsd = numberField(data, 'budgetUsd', 'budget_usd') ?? 0;
  const totalSpendUsd = numberField(data, 'totalSpendUsd', 'total_spend_usd') ?? 0;
  const remainingUsd =
    numberField(data, 'remainingUsd', 'remaining_usd') ?? budgetUsd - totalSpendUsd;
  const isOverBudget =
    booleanField(data, 'isOverBudget', 'is_over_budget') ?? remainingUsd < 0;
  return { budgetUsd, totalSpendUsd, remainingUsd, isOverBudget };
}

export type BudgetMeterTone = 'ok' | 'warning' | 'over';

/** Which York allowance the current workspace draws from. `none` → OpenRouter. */
export type ActiveBudgetSource = 'project' | 'user' | 'none';

/** Live meter snapshot pushed after usage ingest (and seeded from GET ai-budget). */
export interface HubUsageMeterSnapshot {
  userBudgetPercent: number | null;
  projectBudgetPercent: number | null;
  lastTurnTokens: number | null;
  updatedAt: number;
  activeSource?: ActiveBudgetSource;
  checkedDivisionKey?: string | null;
}

/** null when there is no FY ceiling / percent to show. */
export function budgetMeterTone(percent: number | null | undefined): BudgetMeterTone | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  if (percent >= 100) return 'over';
  if (percent >= 80) return 'warning';
  return 'ok';
}

export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) {
    const value = n / 1_000_000;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1000) {
    const value = n / 1000;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(n));
}

/** Visual fill 0–100; over-budget still caps the bar. */
export function budgetMeterFillPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(percent, 100);
}

export function userBudgetPercentFromSnapshot(snapshot: {
  status?: string | null;
  amount?: number | null;
  spent?: number | null;
}): number | null {
  if (snapshot.status === 'unset') return null;
  if (
    typeof snapshot.amount === 'number' &&
    Number.isFinite(snapshot.amount) &&
    snapshot.amount > 0 &&
    typeof snapshot.spent === 'number' &&
    Number.isFinite(snapshot.spent)
  ) {
    return (snapshot.spent / snapshot.amount) * 100;
  }
  if (snapshot.status === 'over') return 100;
  return null;
}

export function launchPadBudgetPercent(
  budget: LaunchPadProjectBudget | null | undefined
): number | null {
  if (!budget || !Number.isFinite(budget.budgetUsd) || budget.budgetUsd <= 0) return null;
  return (budget.totalSpendUsd / budget.budgetUsd) * 100;
}

/** True when a Hub snapshot has a real ceiling (not unset / missing). */
export function hasAiBudgetCeiling(snapshot: {
  status?: string | null;
  amount?: number | null;
} | null | undefined): boolean {
  if (!snapshot) return false;
  if (snapshot.status === 'unset') return false;
  if (snapshot.status === 'ok' || snapshot.status === 'warning' || snapshot.status === 'over') {
    return true;
  }
  return (
    typeof snapshot.amount === 'number' && Number.isFinite(snapshot.amount) && snapshot.amount > 0
  );
}

export function hasLaunchPadBudgetCeiling(
  budget: LaunchPadProjectBudget | null | undefined
): boolean {
  return Boolean(budget && Number.isFinite(budget.budgetUsd) && budget.budgetUsd > 0);
}

export function divisionBudgetCheckKey(division: {
  kind?: string | null;
  canonicalKey?: string;
  folderId?: string;
} | null | undefined): string {
  const kind = division?.kind || 'none';
  if (kind === 'project') return `project:${division?.canonicalKey || ''}`;
  if (kind === 'client') return `client:${division?.canonicalKey || ''}`;
  if (kind === 'folder') return `folder:${division?.folderId || ''}`;
  return kind;
}

/**
 * Project allowance first, then personal, then OpenRouter (`none`).
 * General / Folders always `none` (OpenRouter-only workspaces).
 */
export function resolveActiveBudgetSource(input: {
  divisionKind?: string | null;
  projectHasBudget: boolean;
  userHasBudget: boolean;
}): ActiveBudgetSource {
  const kind = input.divisionKind;
  if (kind === 'general' || kind === 'folder' || !kind) return 'none';
  if ((kind === 'project' || kind === 'client') && input.projectHasBudget) return 'project';
  if (input.userHasBudget) return 'user';
  return 'none';
}

export function resolveActiveBudgetPercent(
  source: ActiveBudgetSource,
  userPercent: number | null,
  projectPercent: number | null
): number | null {
  if (source === 'project') return projectPercent;
  if (source === 'user') return userPercent;
  return null;
}

export function withResolvedActiveBudget(
  snapshot: HubUsageMeterSnapshot,
  divisionKind: string | null | undefined
): HubUsageMeterSnapshot {
  const projectHasBudget =
    (divisionKind === 'project' || divisionKind === 'client') &&
    snapshot.projectBudgetPercent != null;
  const userHasBudget = snapshot.userBudgetPercent != null;
  return {
    ...snapshot,
    activeSource: resolveActiveBudgetSource({
      divisionKind,
      projectHasBudget,
      userHasBudget,
    }),
  };
}

/** When the workspace is on the project allowance, overlay paid models from that ceiling. */
export function applyActiveProjectBudgetToModels<
  T extends { hasBudget?: boolean; isFree?: boolean },
>(models: T[], projectPercent: number | null | undefined): T[] {
  if (projectPercent == null || !Number.isFinite(projectPercent)) return models;
  if (projectPercent >= 100) {
    return models.map((m) => (m.isFree === true ? m : { ...m, hasBudget: false }));
  }
  return models.map((m) => (m.hasBudget === false ? { ...m, hasBudget: true } : m));
}

export function isUserAiBudgetOver(status: string | null | undefined): boolean {
  return status === 'over';
}

/** usable=true treats over and unset as no org-key paid access (has_budget false). */
export function isUserAiBudgetBlockingPaid(status: string | null | undefined): boolean {
  return status === 'over' || status === 'unset';
}

/**
 * LaunchPad overlay needs the unfiltered grant list (omit usable) so paid models
 * are present to re-enable. Default consumer catalog uses usable=true.
 */
export function shouldUseUnfilteredAllowedModels(input: {
  strategy: ProjectBudgetGateStrategy | null;
  userBudgetStatus?: string | null;
}): boolean {
  if (input.strategy === 'launchpad') return true;
  if (input.strategy === 'both') return isUserAiBudgetBlockingPaid(input.userBudgetStatus);
  return false;
}

/**
 * Resolve Project budget strategy from division sources / ids.
 * Prefer explicit `sources` when present; otherwise infer from Hub / LaunchPad ids.
 * Non-project divisions → null (no project budget path).
 */
export function resolveProjectBudgetGateStrategy(input: {
  division?: string | null;
  sources?: { hub?: boolean; launchpad?: boolean } | null;
  hubProjectId?: string | null;
  launchpadProjectId?: number | null;
}): ProjectBudgetGateStrategy | null {
  if (input.division !== 'project') return null;

  const sourcesProvided =
    Boolean(input.sources) &&
    (Boolean(input.sources?.hub) || Boolean(input.sources?.launchpad));

  const hub = sourcesProvided ? Boolean(input.sources?.hub) : hasHubProjectLink(input);
  const lp = sourcesProvided
    ? Boolean(input.sources?.launchpad)
    : hasLaunchPadProjectLink(input);

  if (hub && lp) return 'both';
  if (lp) return 'launchpad';
  if (hub) return 'hub';
  return null;
}

/**
 * Whether FE should fetch LaunchPad project budget for the current Project strategy.
 * - launchpad-only: always (LaunchPad is the sole gate)
 * - both: when Hub user FY is over or unset (has_budget false with usable=true)
 * - hub-only: never
 */
export function shouldFetchLaunchPadProjectBudget(input: {
  strategy: ProjectBudgetGateStrategy | null;
  userBudgetStatus?: string | null;
  launchpadProjectId?: number | null;
}): boolean {
  if (
    typeof input.launchpadProjectId !== 'number' ||
    !Number.isFinite(input.launchpadProjectId) ||
    input.launchpadProjectId <= 0
  ) {
    return false;
  }
  if (input.strategy === 'launchpad') return true;
  if (input.strategy === 'both') return isUserAiBudgetBlockingPaid(input.userBudgetStatus);
  return false;
}

/** @deprecated Prefer shouldFetchLaunchPadProjectBudget + resolveProjectBudgetGateStrategy. */
export function shouldUseLaunchPadProjectBudgetFallback(input: {
  division?: string | null;
  userBudgetStatus?: string | null;
  launchpadProjectId?: number | null;
  sources?: { hub?: boolean; launchpad?: boolean } | null;
  hubProjectId?: string | null;
}): boolean {
  const strategy = resolveProjectBudgetGateStrategy(input);
  return shouldFetchLaunchPadProjectBudget({
    strategy,
    userBudgetStatus: input.userBudgetStatus,
    launchpadProjectId: input.launchpadProjectId,
  });
}

/**
 * LaunchPad-only projects: LaunchPad budget is the sole paid-proxy gate.
 * Over → force paid models to hasBudget false; under → re-enable paid.
 */
export function applyLaunchPadBudgetAsSoleGateToModels<
  T extends { hasBudget?: boolean; isFree?: boolean },
>(models: T[], launchPadBudget: LaunchPadProjectBudget | null | undefined): T[] {
  if (!launchPadBudget) return models;
  if (launchPadBudget.isOverBudget) {
    return models.map((m) => (m.isFree === true ? m : { ...m, hasBudget: false }));
  }
  return models.map((m) => (m.hasBudget === false ? { ...m, hasBudget: true } : m));
}

/**
 * Dual-linked projects: when Hub user FY is over or unset, LaunchPad under-budget re-enables paid.
 * Does not tighten the gate when LaunchPad is over (Hub has_budget already applied).
 */
export function applyLaunchPadBudgetFallbackToModels<
  T extends { hasBudget?: boolean; isFree?: boolean },
>(models: T[], launchPadBudget: LaunchPadProjectBudget | null | undefined): T[] {
  if (!launchPadBudget || launchPadBudget.isOverBudget) return models;
  return models.map((m) => (m.hasBudget === false ? { ...m, hasBudget: true } : m));
}
