import { describe, expect, it, vi } from 'vitest';
import { fetchProjectBudgetForToken } from '../../main/launchpad/launchpad-projects';

vi.mock('../../shared/auth-config', () => ({
  authConfig: {
    launchpadMcpUrl: 'https://launchpad.test/mcp',
  },
}));

describe('fetchProjectBudgetForToken', () => {
  it('GETs /api/projects/:id/budget', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        budgetUsd: 1000,
        totalSpendUsd: 250.5,
        remainingUsd: 749.5,
        isOverBudget: false,
      }),
    })) as unknown as typeof fetch;

    const budget = await fetchProjectBudgetForToken({
      projectId: 42,
      token: 'id-token',
      fetchFn,
      baseUrl: 'https://launchpad.test',
    });

    expect(budget).toEqual({
      budgetUsd: 1000,
      totalSpendUsd: 250.5,
      remainingUsd: 749.5,
      isOverBudget: false,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://launchpad.test/api/projects/42/budget',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer id-token' }),
      })
    );
  });
});
