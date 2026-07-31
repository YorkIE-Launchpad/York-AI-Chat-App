import { describe, expect, it } from 'vitest';
import {
  buildDivisionSystemPrompt,
  divisionMemoryKey,
  filterMcpToolsForDivision,
  isMcpToolExcludedInHubDivision,
  normalizeSessionDivision,
  sessionMatchesActiveDivision,
} from '../../shared/workspace-division';
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
    });
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
  });

  it('matches sessions to active division', () => {
    expect(sessionMatchesActiveDivision({ division: 'general' }, { kind: 'general' })).toBe(true);
    expect(sessionMatchesActiveDivision({ division: 'hub' }, { kind: 'general' })).toBe(false);
    expect(sessionMatchesActiveDivision({ division: 'general' }, null)).toBe(false);
    expect(
      sessionMatchesActiveDivision(
        { division: 'project', hubProjectId: 'a', hubProjectName: 'A' },
        { kind: 'project', hubProjectId: 'a', hubProjectName: 'A' }
      )
    ).toBe(true);
    expect(
      sessionMatchesActiveDivision(
        { division: 'project', hubProjectId: 'a', hubProjectName: 'A' },
        { kind: 'project', hubProjectId: 'b', hubProjectName: 'B' }
      )
    ).toBe(false);
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
  it('uses /api/users/:email/allocated-projects when successful', async () => {
    const { fetchAllocatedProjectsForUser } = await import('../../main/hub/hub-allocations');
    const fetchFn = async (url: string | URL) => {
      const href = String(url);
      expect(href).toContain('/api/users/me%40york.ie/allocated-projects');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ id: '1', title: 'FromUserAlloc' }],
        }),
      } as Response;
    };
    const projects = await fetchAllocatedProjectsForUser({
      token: 'tok',
      email: 'me@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(projects).toEqual([{ id: '1', name: 'FromUserAlloc' }]);
  });

  it('falls back to /api/projects/external/list on non-auth failure', async () => {
    const { fetchAllocatedProjectsForUser } = await import('../../main/hub/hub-allocations');
    const calls: string[] = [];
    const fetchFn = async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('/allocated-projects')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ success: false }),
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
    expect(calls.some((c) => c.includes('/allocated-projects'))).toBe(true);
    expect(calls.some((c) => c.includes('/api/projects/external/list'))).toBe(true);
    expect(projects).toEqual([{ id: '7', name: 'FallbackProj', hours: 4 }]);
  });

  it('retries allocated-projects with alternate token on 401', async () => {
    const { fetchAllocatedProjectsForUser } = await import('../../main/hub/hub-allocations');
    const authHeaders: string[] = [];
    const fetchFn = async (_url: string | URL, init?: RequestInit) => {
      const header = String((init?.headers as Record<string, string>)?.Authorization || '');
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

  it('throws on 401 when both tokens fail allocated-projects', async () => {
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
