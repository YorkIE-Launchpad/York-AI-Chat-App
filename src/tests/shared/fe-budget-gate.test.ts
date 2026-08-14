import { describe, expect, it } from 'vitest';
import {
  applyLaunchPadBudgetAsSoleGateToModels,
  applyLaunchPadBudgetFallbackToModels,
  isUserAiBudgetBlockingPaid,
  isUserAiBudgetOver,
  parseHubUserAiBudget,
  parseLaunchPadProjectBudget,
  resolveProjectBudgetGateStrategy,
  shouldFetchLaunchPadProjectBudget,
  shouldUseLaunchPadProjectBudgetFallback,
  shouldUseUnfilteredAllowedModels,
} from '../../shared/fe-budget-gate';

describe('parseHubUserAiBudget', () => {
  it('parses apidoc snapshot envelope', () => {
    const parsed = parseHubUserAiBudget({
      success: true,
      data: {
        status: 'ok',
        amount: 500,
        spent: 128.45,
        remaining: 371.55,
        currency: 'USD',
        fiscal_year_label: 'FY 2025–26',
      },
    });
    expect(parsed).toEqual({
      status: 'ok',
      amount: 500,
      spent: 128.45,
      remaining: 371.55,
      currency: 'USD',
      fiscalYearLabel: 'FY 2025–26',
    });
  });

  it('treats missing/unknown status as unset', () => {
    expect(parseHubUserAiBudget({ status: 'weird' }).status).toBe('unset');
    expect(parseHubUserAiBudget({}).status).toBe('unset');
  });
});

describe('parseLaunchPadProjectBudget', () => {
  it('parses LaunchPad budget response', () => {
    expect(
      parseLaunchPadProjectBudget({
        budgetUsd: 1000,
        totalSpendUsd: 250.5,
        remainingUsd: 749.5,
        isOverBudget: false,
      })
    ).toEqual({
      budgetUsd: 1000,
      totalSpendUsd: 250.5,
      remainingUsd: 749.5,
      isOverBudget: false,
    });
  });

  it('infers isOverBudget from remaining when flag omitted', () => {
    expect(
      parseLaunchPadProjectBudget({
        budget_usd: 100,
        total_spend_usd: 150,
        remaining_usd: -50,
      }).isOverBudget
    ).toBe(true);
  });
});

describe('resolveProjectBudgetGateStrategy', () => {
  it('returns hub / launchpad / both from sources', () => {
    expect(
      resolveProjectBudgetGateStrategy({
        division: 'project',
        sources: { hub: true },
        hubProjectId: 'h1',
      })
    ).toBe('hub');
    expect(
      resolveProjectBudgetGateStrategy({
        division: 'project',
        sources: { launchpad: true },
        launchpadProjectId: 9,
      })
    ).toBe('launchpad');
    expect(
      resolveProjectBudgetGateStrategy({
        division: 'project',
        sources: { hub: true, launchpad: true },
        hubProjectId: 'h1',
        launchpadProjectId: 9,
      })
    ).toBe('both');
  });

  it('infers from ids when sources omitted', () => {
    expect(
      resolveProjectBudgetGateStrategy({
        division: 'project',
        hubProjectId: 'h1',
      })
    ).toBe('hub');
    expect(
      resolveProjectBudgetGateStrategy({
        division: 'project',
        launchpadProjectId: 3,
      })
    ).toBe('launchpad');
    expect(
      resolveProjectBudgetGateStrategy({
        division: 'project',
        hubProjectId: 'h1',
        launchpadProjectId: 3,
      })
    ).toBe('both');
  });

  it('is null outside Project', () => {
    expect(
      resolveProjectBudgetGateStrategy({
        division: 'hub',
        hubProjectId: 'h1',
        launchpadProjectId: 1,
      })
    ).toBeNull();
  });
});

describe('shouldFetchLaunchPadProjectBudget', () => {
  it('hub-only never fetches LaunchPad', () => {
    expect(
      shouldFetchLaunchPadProjectBudget({
        strategy: 'hub',
        userBudgetStatus: 'over',
        launchpadProjectId: 9,
      })
    ).toBe(false);
  });

  it('launchpad-only always fetches when lp id present', () => {
    expect(
      shouldFetchLaunchPadProjectBudget({
        strategy: 'launchpad',
        userBudgetStatus: 'ok',
        launchpadProjectId: 9,
      })
    ).toBe(true);
    expect(
      shouldFetchLaunchPadProjectBudget({
        strategy: 'launchpad',
        userBudgetStatus: 'over',
        launchpadProjectId: null,
      })
    ).toBe(false);
  });

  it('both fetches when Hub user is over or unset', () => {
    expect(
      shouldFetchLaunchPadProjectBudget({
        strategy: 'both',
        userBudgetStatus: 'over',
        launchpadProjectId: 9,
      })
    ).toBe(true);
    expect(
      shouldFetchLaunchPadProjectBudget({
        strategy: 'both',
        userBudgetStatus: 'unset',
        launchpadProjectId: 9,
      })
    ).toBe(true);
    expect(
      shouldFetchLaunchPadProjectBudget({
        strategy: 'both',
        userBudgetStatus: 'ok',
        launchpadProjectId: 9,
      })
    ).toBe(false);
    expect(
      shouldFetchLaunchPadProjectBudget({
        strategy: 'both',
        userBudgetStatus: 'warning',
        launchpadProjectId: 9,
      })
    ).toBe(false);
  });
});

describe('shouldUseUnfilteredAllowedModels', () => {
  it('is true for launchpad-only and both when Hub is blocking', () => {
    expect(shouldUseUnfilteredAllowedModels({ strategy: 'launchpad' })).toBe(true);
    expect(
      shouldUseUnfilteredAllowedModels({ strategy: 'both', userBudgetStatus: 'over' })
    ).toBe(true);
    expect(
      shouldUseUnfilteredAllowedModels({ strategy: 'both', userBudgetStatus: 'unset' })
    ).toBe(true);
    expect(
      shouldUseUnfilteredAllowedModels({ strategy: 'both', userBudgetStatus: 'ok' })
    ).toBe(false);
    expect(shouldUseUnfilteredAllowedModels({ strategy: 'hub' })).toBe(false);
    expect(shouldUseUnfilteredAllowedModels({ strategy: null })).toBe(false);
  });
});

describe('FE Project budget apply helpers', () => {
  it('fallback re-enables paid when LaunchPad is not over', () => {
    const models = [
      { id: 'gpt-4o', hasBudget: false, isFree: false },
      { id: 'haiku', hasBudget: true, isFree: true },
    ];
    const gated = applyLaunchPadBudgetFallbackToModels(models, {
      budgetUsd: 1000,
      totalSpendUsd: 100,
      remainingUsd: 900,
      isOverBudget: false,
    });
    expect(gated[0]?.hasBudget).toBe(true);
    expect(gated[1]?.hasBudget).toBe(true);
  });

  it('fallback keeps paid gated when LaunchPad is over', () => {
    const models = [{ id: 'gpt-4o', hasBudget: false }];
    const gated = applyLaunchPadBudgetFallbackToModels(models, {
      budgetUsd: 100,
      totalSpendUsd: 120,
      remainingUsd: -20,
      isOverBudget: true,
    });
    expect(gated[0]?.hasBudget).toBe(false);
  });

  it('sole gate disables paid when LaunchPad is over (even if Hub had budget)', () => {
    const models = [
      { id: 'gpt-4o', hasBudget: true, isFree: false },
      { id: 'haiku', hasBudget: true, isFree: true },
    ];
    const gated = applyLaunchPadBudgetAsSoleGateToModels(models, {
      budgetUsd: 50,
      totalSpendUsd: 60,
      remainingUsd: -10,
      isOverBudget: true,
    });
    expect(gated[0]?.hasBudget).toBe(false);
    expect(gated[1]?.hasBudget).toBe(true);
  });

  it('sole gate re-enables paid when LaunchPad has remaining', () => {
    const models = [{ id: 'gpt-4o', hasBudget: false, isFree: false }];
    const gated = applyLaunchPadBudgetAsSoleGateToModels(models, {
      budgetUsd: 1000,
      totalSpendUsd: 10,
      remainingUsd: 990,
      isOverBudget: false,
    });
    expect(gated[0]?.hasBudget).toBe(true);
  });

  it('deprecated helper matches both-strategy fallback', () => {
    expect(
      shouldUseLaunchPadProjectBudgetFallback({
        division: 'project',
        sources: { hub: true, launchpad: true },
        hubProjectId: 'h1',
        userBudgetStatus: 'over',
        launchpadProjectId: 9,
      })
    ).toBe(true);
    expect(
      shouldUseLaunchPadProjectBudgetFallback({
        division: 'project',
        sources: { hub: true },
        hubProjectId: 'h1',
        userBudgetStatus: 'over',
        launchpadProjectId: 9,
      })
    ).toBe(false);
  });

  it('isUserAiBudgetOver only for over', () => {
    expect(isUserAiBudgetOver('over')).toBe(true);
    expect(isUserAiBudgetOver('warning')).toBe(false);
    expect(isUserAiBudgetOver('ok')).toBe(false);
    expect(isUserAiBudgetOver('unset')).toBe(false);
  });

  it('isUserAiBudgetBlockingPaid for over and unset', () => {
    expect(isUserAiBudgetBlockingPaid('over')).toBe(true);
    expect(isUserAiBudgetBlockingPaid('unset')).toBe(true);
    expect(isUserAiBudgetBlockingPaid('ok')).toBe(false);
    expect(isUserAiBudgetBlockingPaid('warning')).toBe(false);
  });
});
