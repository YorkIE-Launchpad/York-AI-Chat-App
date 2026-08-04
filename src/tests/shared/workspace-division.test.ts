import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildDivisionSystemPrompt,
  divisionMemoryKey,
  filterMcpToolsForDivision,
  filterModelsForDivision,
  isMcpToolExcludedInHubDivision,
  isProviderAllowedInDivision,
  normalizeSessionDivision,
  sessionMatchesActiveDivision,
} from '../../shared/workspace-division';
import { filterModelsForOpenRouterKey } from '../../shared/openrouter-fallback';
import type { BackendModelInfo } from '../../shared/backend-config';
import {
  parseActiveUsersWithAllocations,
  parseClientsWithAllocations,
  parseUserAllocatedProjects,
  normalizeAllocatedProject,
} from '../../main/hub/hub-allocations';

describe('workspace-division', () => {
  it('normalizes missing project id to general', () => {
    expect(normalizeSessionDivision({ division: 'project' })).toEqual({
      division: 'general',
      hubProjectId: null,
      hubProjectName: null,
      launchpadProjectId: null,
      launchpadProjectName: null,
      folderId: null,
      folderName: null,
      canonicalKey: null,
    });
  });

  it('keeps launchpad-only project sessions', () => {
    const n = normalizeSessionDivision({
      division: 'project',
      launchpadProjectId: 9,
      launchpadProjectName: 'Solo',
    });
    expect(n.division).toBe('project');
    expect(n.launchpadProjectId).toBe(9);
    expect(n.hubProjectId).toBeNull();
    expect(n.canonicalKey).toBe('lp:9');
  });

  it('builds division memory keys', () => {
    expect(divisionMemoryKey({ division: 'general' })).toBe('vecos://general');
    expect(divisionMemoryKey({ division: 'hub' })).toBe('vecos://hub');
    expect(
      divisionMemoryKey({
        division: 'project',
        hubProjectId: 'proj-1',
        hubProjectName: 'Acme',
      })
    ).toBe('vecos://project/proj-1');
    expect(
      divisionMemoryKey({
        division: 'project',
        launchpadProjectId: 42,
        launchpadProjectName: 'LP',
      })
    ).toBe('vecos://project/lp/42');
    expect(divisionMemoryKey({ division: 'folder', folderId: 'f1', folderName: 'Notes' })).toBe(
      'vecos://folder/f1'
    );
  });

  it('matches sessions to active division', () => {
    expect(sessionMatchesActiveDivision({ division: 'general' }, { kind: 'general' })).toBe(true);
    expect(sessionMatchesActiveDivision({ division: 'hub' }, { kind: 'general' })).toBe(false);
    expect(sessionMatchesActiveDivision({ division: 'general' }, null)).toBe(false);
    expect(
      sessionMatchesActiveDivision(
        { division: 'project', hubProjectId: 'a', hubProjectName: 'A' },
        {
          kind: 'project',
          canonicalKey: 'hub:a',
          name: 'A',
          hubProjectId: 'a',
          hubProjectName: 'A',
          sources: { hub: true },
        }
      )
    ).toBe(true);
    expect(
      sessionMatchesActiveDivision(
        { division: 'project', hubProjectId: 'a', hubProjectName: 'A' },
        {
          kind: 'project',
          canonicalKey: 'hub:b',
          name: 'B',
          hubProjectId: 'b',
          hubProjectName: 'B',
          sources: { hub: true },
        }
      )
    ).toBe(false);
    expect(
      sessionMatchesActiveDivision(
        { division: 'project', launchpadProjectId: 5 },
        {
          kind: 'project',
          canonicalKey: 'lp:5',
          name: 'LP',
          launchpadProjectId: 5,
          sources: { launchpad: true },
        }
      )
    ).toBe(true);
    expect(
      sessionMatchesActiveDivision(
        { division: 'folder', folderId: 'f1' },
        { kind: 'folder', folderId: 'f1', folderName: 'Notes' }
      )
    ).toBe(true);
  });

  it('excludes Launchpad and Pulse MCP tools in Hub division', () => {
    expect(isMcpToolExcludedInHubDivision('mcp__R_D_Launchpad__list_releases')).toBe(true);
    expect(isMcpToolExcludedInHubDivision('mcp__Launchpad__foo')).toBe(true);
    expect(isMcpToolExcludedInHubDivision('mcp__R_D_Pulse__metrics')).toBe(true);
    expect(isMcpToolExcludedInHubDivision('mcp__GTM_Pulse__funnel')).toBe(true);
    expect(isMcpToolExcludedInHubDivision('mcp__York_IE_HUB__list_employees')).toBe(false);

    const tools = [
      { name: 'mcp__York_IE_HUB__list_employees' },
      { name: 'mcp__R_D_Launchpad__list_releases' },
      { name: 'mcp__R_D_Pulse__metrics' },
    ];
    expect(filterMcpToolsForDivision(tools, { division: 'hub' }).map((t) => t.name)).toEqual([
      'mcp__York_IE_HUB__list_employees',
    ]);
    expect(filterMcpToolsForDivision(tools, { division: 'general' })).toHaveLength(3);
    expect(
      filterMcpToolsForDivision(tools, {
        division: 'project',
        hubProjectId: 'p1',
        hubProjectName: 'P',
      })
    ).toHaveLength(3);
  });

  it('builds division system prompts', () => {
    const hubPrompt = buildDivisionSystemPrompt({ division: 'hub' });
    expect(hubPrompt).toContain('Hub mode');
    expect(hubPrompt).toContain('OUT OF SCOPE (REFUSE)');
    expect(hubPrompt).toContain('switch to General');
    expect(hubPrompt).toContain('Hub client/project records and allocations ARE in scope');

    const projectPrompt = buildDivisionSystemPrompt({
      division: 'project',
      hubProjectId: 'p1',
      hubProjectName: 'Acme',
    });
    expect(projectPrompt).toContain('Acme');
    expect(projectPrompt).toContain('p1');
    expect(projectPrompt).toContain('OUT OF SCOPE (REFUSE)');
    expect(projectPrompt).toContain('switch to General');

    expect(buildDivisionSystemPrompt({ division: 'general' })).toContain('General mode');
    expect(buildDivisionSystemPrompt({ division: 'general' })).not.toContain(
      'OUT OF SCOPE (REFUSE)'
    );
  });

  it('restricts General workspace models to OpenRouter only', () => {
    const catalog: BackendModelInfo[] = [
      { id: 'openrouter/free', name: 'Free', provider: 'openrouter' },
      { id: 'claude-haiku-4-5', name: 'Haiku', provider: 'anthropic' },
      { id: 'gpt-5.4-mini', name: 'Mini', provider: 'openai' },
      { id: 'gemini-2.5-flash', name: 'Flash', provider: 'gemini' },
    ];

    expect(
      filterModelsForDivision(catalog, { division: 'general' }).map((m) => m.provider)
    ).toEqual(['openrouter']);
    expect(
      filterModelsForDivision(catalog, {
        division: 'folder',
        folderId: 'f1',
        folderName: 'Notes',
      }).map((m) => m.provider)
    ).toEqual(['openrouter']);
    expect(filterModelsForDivision(catalog, { division: 'hub' })).toHaveLength(4);
    expect(
      filterModelsForDivision(catalog, {
        division: 'project',
        hubProjectId: 'p1',
        hubProjectName: 'P',
      })
    ).toHaveLength(4);

    expect(isProviderAllowedInDivision('openrouter', { division: 'general' })).toBe(true);
    expect(isProviderAllowedInDivision('anthropic', { division: 'general' })).toBe(false);
    expect(isProviderAllowedInDivision('anthropic', { division: 'folder' })).toBe(false);
    expect(isProviderAllowedInDivision('anthropic', { division: 'hub' })).toBe(true);
    expect(isProviderAllowedInDivision('openrouter', { division: 'hub' })).toBe(true);

    // Compose with missing BYOK → empty catalog in General without key
    expect(
      filterModelsForOpenRouterKey(filterModelsForDivision(catalog, { division: 'general' }), '')
    ).toEqual([]);
    expect(
      filterModelsForOpenRouterKey(
        filterModelsForDivision(catalog, { division: 'general' }),
        'sk-or'
      ).map((m) => m.provider)
    ).toEqual(['openrouter']);

    // No division context → pass-through (do not default to General)
    expect(filterModelsForDivision(catalog, null)).toHaveLength(4);
    expect(filterModelsForDivision(catalog, undefined)).toHaveLength(4);
    expect(filterModelsForDivision(catalog, {})).toHaveLength(4);
    expect(isProviderAllowedInDivision('anthropic', null)).toBe(true);
  });
});

describe('hub-allocations parsers', () => {
  it('parses /api/users/:email/allocated-projects shape', () => {
    const projects = parseUserAllocatedProjects({
      success: true,
      data: [
        { id: '1', title: 'Alpha', hours: 10 },
        { id: '2', title: 'Beta', hours: 5 },
      ],
    });
    expect(projects).toEqual([
      { id: '1', name: 'Alpha', hours: 10 },
      { id: '2', name: 'Beta', hours: 5 },
    ]);
  });

  it('parses projects/external/list and legacy client shapes', () => {
    const projects = parseClientsWithAllocations({
      success: true,
      data: [
        { id: '1', title: 'Alpha', hours: 10 },
        { id: '2', name: 'Beta', hours: 5 },
      ],
    });
    expect(projects).toEqual([
      { id: '1', name: 'Alpha', hours: 10 },
      { id: '2', name: 'Beta', hours: 5 },
    ]);
  });

  it('parses users/active-with-allocations filtered by email', () => {
    const projects = parseActiveUsersWithAllocations(
      {
        success: true,
        data: {
          users: [
            {
              email: 'other@york.ie',
              allocations: [{ id: 'x', name: 'Other' }],
            },
            {
              email: 'me@york.ie',
              allocations: [
                { id: '1', name: 'Alpha', hours: 8, title: 'PM' },
                { id: '1', name: 'Alpha Dup' },
              ],
            },
          ],
        },
      },
      'me@york.ie'
    );
    // title field on allocation is treated as name when name missing; here name is Alpha
    expect(projects).toEqual([{ id: '1', name: 'Alpha', hours: 8, title: 'PM' }]);
  });

  it('returns empty when email has no match', () => {
    expect(
      parseActiveUsersWithAllocations(
        { success: true, data: { users: [{ email: 'a@york.ie', allocations: [] }] } },
        'missing@york.ie'
      )
    ).toEqual([]);
  });

  it('normalizes nested project objects', () => {
    expect(
      normalizeAllocatedProject({
        project: { id: '99', name: 'Nested' },
        hours: 3,
      })
    ).toEqual({ id: '99', name: 'Nested', hours: 3 });
  });
});

describe('fetchAllocatedProjectsForUser', () => {
  beforeEach(async () => {
    const { clearPrimarySkipCache, clearHubAllocationsCache } =
      await import('../../main/hub/hub-allocations');
    clearPrimarySkipCache();
    clearHubAllocationsCache();
  });

  it('uses /api/projects/list when successful with items', async () => {
    const { fetchAllocatedProjectsForUser } = await import('../../main/hub/hub-allocations');
    const calls: string[] = [];
    const fetchFn = async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      expect(href).toContain('/api/projects/list');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ id: '1', title: 'FromList' }],
        }),
      } as Response;
    };
    const projects = await fetchAllocatedProjectsForUser({
      token: 'tok',
      email: 'me@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(projects).toEqual([{ id: '1', name: 'FromList' }]);
    expect(calls.some((c) => c.includes('/allocated-projects'))).toBe(false);
  });

  it('falls back to allocated-projects when list is empty and caches skip', async () => {
    const { fetchAllocatedProjectsForUser, isPrimaryProjectsListSkipped } =
      await import('../../main/hub/hub-allocations');
    const calls: string[] = [];
    const fetchFn = async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('/api/projects/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [] }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ id: '7', title: 'FallbackProj', hours: 4 }],
        }),
      } as Response;
    };
    const projects = await fetchAllocatedProjectsForUser({
      token: 'tok',
      email: 'me@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(calls.filter((c) => c.includes('/api/projects/list')).length).toBe(1);
    expect(calls.some((c) => c.includes('/allocated-projects'))).toBe(true);
    expect(projects).toEqual([{ id: '7', name: 'FallbackProj', hours: 4 }]);
    expect(isPrimaryProjectsListSkipped('me@york.ie')).toBe(true);
  });

  it('falls back on 401/403 from projects/list', async () => {
    const { fetchAllocatedProjectsForUser } = await import('../../main/hub/hub-allocations');
    const fetchFn = async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/api/projects/list')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ success: false }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ id: '9', title: 'AllocOnly' }],
        }),
      } as Response;
    };
    const projects = await fetchAllocatedProjectsForUser({
      token: 'tok',
      email: 'me@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(projects).toEqual([{ id: '9', name: 'AllocOnly' }]);
  });

  it('skips projects/list on second call while primary-skip is active', async () => {
    const { fetchAllocatedProjectsForUser } = await import('../../main/hub/hub-allocations');
    const calls: string[] = [];
    const fetchFn = async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('/api/projects/list')) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ success: false }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ id: '3', title: 'CachedFallback' }],
        }),
      } as Response;
    };
    await fetchAllocatedProjectsForUser({
      token: 'tok',
      email: 'me@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    calls.length = 0;
    const projects = await fetchAllocatedProjectsForUser({
      token: 'tok',
      email: 'me@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(calls.some((c) => c.includes('/api/projects/list'))).toBe(false);
    expect(calls.some((c) => c.includes('/allocated-projects'))).toBe(true);
    expect(projects).toEqual([{ id: '3', name: 'CachedFallback' }]);
  });

  it('retries projects/list with alternate token on 401', async () => {
    const { fetchAllocatedProjectsForUser, clearPrimarySkipCache } =
      await import('../../main/hub/hub-allocations');
    clearPrimarySkipCache();
    const authHeaders: string[] = [];
    const fetchFn = async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const header = String((init?.headers as Record<string, string>)?.Authorization || '');
      if (href.includes('/api/projects/list')) {
        authHeaders.push(header);
        if (header.includes('access-tok')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ success: false }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [{ id: '2', title: 'ViaId' }],
          }),
        } as Response;
      }
      throw new Error('should not call allocated-projects');
    };
    const projects = await fetchAllocatedProjectsForUser({
      token: 'access-tok',
      alternateToken: 'id-tok',
      email: 'me@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(authHeaders).toEqual(['Bearer access-tok', 'Bearer id-tok']);
    expect(projects).toEqual([{ id: '2', name: 'ViaId' }]);
  });

  it('throws when fallback allocated-projects also fails', async () => {
    const { fetchAllocatedProjectsForUser, HubAllocationsError } =
      await import('../../main/hub/hub-allocations');
    const fetchFn = async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ success: false }),
      }) as Response;
    await expect(
      fetchAllocatedProjectsForUser({
        token: 'bad',
        alternateToken: 'also-bad',
        email: 'me@york.ie',
        fetchFn: fetchFn as typeof fetch,
      })
    ).rejects.toBeInstanceOf(HubAllocationsError);
  });
});
