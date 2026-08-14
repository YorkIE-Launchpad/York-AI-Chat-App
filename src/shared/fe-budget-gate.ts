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
