import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildDivisionActiveClientContext,
  buildDivisionActiveProjectContext,
  buildDivisionSystemPrompt,
  clientDivisionFromProjects,
  divisionMemoryKey,
  filterMcpToolsForDivision,
  filterModelsForDivision,
  isMcpToolExcludedInHubDivision,
  isProviderAllowedInDivision,
  normalizeSessionDivision,
  serializeClientDivisionProjects,
  sessionMatchesActiveDivision,
} from '../../shared/workspace-division';
import { filterModelsForOpenRouterKey } from '../../shared/openrouter-fallback';
import type { BackendModelInfo } from '../../shared/backend-config';
import {
  parseActiveUsersWithAllocations,
  parseClientsWithAllocations,
  parseUserAllocatedProjects,
  normalizeAllocatedProject,
  enrichAllocatedProjectsWithClientNames,
  parseProjectClientNameIndex,
} from '../../main/hub/hub-allocations';

describe('workspace-division', () => {
  it('normalizes missing project id to general', () => {
    expect(normalizeSessionDivision({ division: 'project' })).toMatchObject({
      division: 'general',
      hubProjectId: null,
      hubProjectName: null,
      launchpadProjectId: null,
      launchpadProjectName: null,
      folderId: null,
      folderName: null,
      canonicalKey: null,
      clientName: null,
      clientProjectIds: null,
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
    expect(hubPrompt).toContain('export or save Hub analysis/results to local files');
    expect(hubPrompt).toContain('CSV');
    expect(hubPrompt).toContain('outputs/');
    expect(hubPrompt).toContain(
      'Do not refuse file exports that contain Hub data the user requested'
    );
    expect(hubPrompt).not.toContain('unrelated file work');

    const projectPrompt = buildDivisionSystemPrompt({
      division: 'project',
      hubProjectId: 'p1',
      hubProjectName: 'Acme',
    });
    expect(projectPrompt).toContain('Acme');
    expect(projectPrompt).toContain('p1');
    expect(projectPrompt).toContain('OUT OF SCOPE (REFUSE)');
    expect(projectPrompt).toContain('switch to General');
    expect(projectPrompt).toContain('DEFAULT SUBJECT');
    expect(projectPrompt).toContain('Do not ask which project');

    const dualPrompt = buildDivisionSystemPrompt({
      division: 'project',
      hubProjectId: 'p1',
      hubProjectName: 'Acme',
      launchpadProjectId: 42,
      launchpadProjectName: 'Acme LP',
    });
    expect(dualPrompt).toContain('DEFAULT SUBJECT');
    expect(dualPrompt).toContain('MANDATORY SKILL: rnd-launchpad-mcp-sdlc');
    expect(dualPrompt).toContain('launchpad project id: 42');

    const lpOnlyPrompt = buildDivisionSystemPrompt({
      division: 'project',
      launchpadProjectId: 7,
      launchpadProjectName: 'Solo LP',
    });
    expect(lpOnlyPrompt).toContain('DEFAULT SUBJECT');
    expect(lpOnlyPrompt).toContain('Solo LP');

    const folderPrompt = buildDivisionSystemPrompt(
      { division: 'folder', folderId: 'f1', folderName: 'Notes' },
      { folderInstructions: 'Always write drafts under drafts/' }
    );
    expect(folderPrompt).toContain('Notes');
    expect(folderPrompt).toContain('Always write drafts under drafts/');
    expect(folderPrompt).toContain('Folder instructions from the user');

    expect(buildDivisionSystemPrompt({ division: 'general' })).toContain('General mode');
    expect(buildDivisionSystemPrompt({ division: 'general' })).not.toContain(
      'OUT OF SCOPE (REFUSE)'
    );
  });

  it('builds active project context only for project sessions', () => {
    expect(buildDivisionActiveProjectContext({ division: 'hub' })).toBe('');
    expect(buildDivisionActiveProjectContext({ division: 'general' })).toBe('');

    const hubCtx = buildDivisionActiveProjectContext({
      division: 'project',
      hubProjectId: 'hub-1',
      hubProjectName: 'Orion',
    });
    expect(hubCtx).toContain('<active_project_context>');
    expect(hubCtx).toContain('Orion');
    expect(hubCtx).toContain('hub-1');
    expect(hubCtx).toContain('do not need to repeat the project name');
    expect(hubCtx).toContain('Never ask which project');

    const lpCtx = buildDivisionActiveProjectContext({
      division: 'project',
      launchpadProjectId: 99,
      launchpadProjectName: 'LP Only',
    });
    expect(lpCtx).toContain('LP Only');
    expect(lpCtx).toContain('LaunchPad project id: 99');
    expect(lpCtx).not.toContain('Hub project id:');

    const dualCtx = buildDivisionActiveProjectContext({
      division: 'project',
      hubProjectId: 'h1',
      hubProjectName: 'Both',
      launchpadProjectId: 3,
      launchpadProjectName: 'Both LP',
    });
    expect(dualCtx).toContain('h1');
    expect(dualCtx).toContain('LaunchPad project id: 3');
  });

  it('normalizes client division with serialized project list', () => {
    const projects = serializeClientDivisionProjects([
      { name: 'Portal', hubProjectId: 'h1', canonicalKey: 'hub:h1' },
      { name: 'Mobile', hubProjectId: 'h2', canonicalKey: 'hub:h2' },
    ]);
    const n = normalizeSessionDivision({
      division: 'client',
      clientName: 'Acme Corp',
      clientProjectIds: projects,
    });
    expect(n.division).toBe('client');
    expect(n.clientName).toBe('Acme Corp');
    expect(n.canonicalKey).toBe('client:acme-corp');
    expect(divisionMemoryKey(n)).toBe('vecos://client/acme-corp');
  });

  it('matches client sessions to active client division', () => {
    const active = clientDivisionFromProjects('Acme Corp', [
      {
        canonicalKey: 'hub:h1',
        name: 'Portal',
        sources: { hub: true },
        hubProjectId: 'h1',
        hubProjectName: 'Portal',
        clientName: 'Acme Corp',
      },
    ]);
    expect(
      sessionMatchesActiveDivision(
        {
          division: 'client',
          clientName: 'Acme Corp',
          clientProjectIds: serializeClientDivisionProjects(active.projects),
          canonicalKey: active.canonicalKey,
        },
        active
      )
    ).toBe(true);
    expect(
      sessionMatchesActiveDivision(
        { division: 'client', clientName: 'Other', clientProjectIds: '[]', canonicalKey: 'client:other' },
        active
      )
    ).toBe(false);
  });

  it('builds client system prompt and active context', () => {
    const projects = serializeClientDivisionProjects([
      { name: 'Portal', hubProjectId: 'h1', canonicalKey: 'hub:h1' },
    ]);
    const session = { division: 'client' as const, clientName: 'Acme Corp', clientProjectIds: projects };
    const prompt = buildDivisionSystemPrompt(session);
    expect(prompt).toContain('locked to client "Acme Corp"');
    expect(prompt).toContain('OUT OF SCOPE');
    const ctx = buildDivisionActiveClientContext(session);
    expect(ctx).toContain('<active_client_context>');
    expect(ctx).toContain('Portal');
    expect(ctx).toContain('h1');
  });

  it('allows Hub-allowed providers in all workspace divisions', () => {
    const catalog: BackendModelInfo[] = [
      { id: 'openrouter/free', name: 'Free', provider: 'openrouter' },
      { id: 'claude-haiku-4-5', name: 'Haiku', provider: 'anthropic' },
      { id: 'gpt-5.4-mini', name: 'Mini', provider: 'openai' },
      { id: 'gemini-2.5-flash', name: 'Flash', provider: 'gemini' },
    ];

    expect(filterModelsForDivision(catalog, { division: 'general' })).toHaveLength(4);
    expect(
      filterModelsForDivision(catalog, {
        division: 'folder',
        folderId: 'f1',
        folderName: 'Notes',
      })
    ).toHaveLength(4);
    expect(filterModelsForDivision(catalog, { division: 'hub' })).toHaveLength(4);
    expect(
      filterModelsForDivision(catalog, {
        division: 'project',
        hubProjectId: 'p1',
        hubProjectName: 'P',
      })
    ).toHaveLength(4);

    expect(isProviderAllowedInDivision('openrouter', { division: 'general' })).toBe(true);
    expect(isProviderAllowedInDivision('anthropic', { division: 'general' })).toBe(true);
    expect(isProviderAllowedInDivision('anthropic', { division: 'folder' })).toBe(true);
    expect(isProviderAllowedInDivision('anthropic', { division: 'hub' })).toBe(true);
    expect(isProviderAllowedInDivision('openrouter', { division: 'hub' })).toBe(true);
    expect(isProviderAllowedInDivision('', { division: 'hub' })).toBe(false);

    // Without BYOK, OpenRouter rows are still filtered out; York providers remain.
    expect(
      filterModelsForOpenRouterKey(filterModelsForDivision(catalog, { division: 'general' }), '').map(
        (m) => m.provider
      )
    ).toEqual(['anthropic', 'openai', 'gemini']);
    expect(
      filterModelsForOpenRouterKey(
        filterModelsForDivision(catalog, { division: 'general' }),
        'sk-or'
      )
    ).toHaveLength(4);

    // No division context → pass-through
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

  it('prefers projectId over allocation id when both are present', () => {
    expect(
      normalizeAllocatedProject({
        id: 'allocation-row-1',
        projectId: 'hub-project-uuid',
        title: 'Alpha',
      })
    ).toEqual({ id: 'hub-project-uuid', name: 'Alpha' });
  });

  it('accepts uuid and project_uuid id fields', () => {
    expect(
      normalizeAllocatedProject({
        uuid: 'uuid-1',
        title: 'Via UUID',
      })
    ).toEqual({ id: 'uuid-1', name: 'Via UUID' });
    expect(
      normalizeAllocatedProject({
        project_uuid: 'proj-uuid-2',
        name: 'Via project_uuid',
      })
    ).toEqual({ id: 'proj-uuid-2', name: 'Via project_uuid' });
  });

  it('parses client_name from project rows', () => {
    expect(
      normalizeAllocatedProject({
        id: 'hub-1',
        name: 'Portal',
        client_name: 'Acme Corp',
      })
    ).toEqual({ id: 'hub-1', name: 'Portal', clientName: 'Acme Corp' });
    expect(
      normalizeAllocatedProject({
        project: { id: 'hub-2', name: 'Mobile', clientName: 'Beta LLC' },
      })
    ).toEqual({ id: 'hub-2', name: 'Mobile', clientName: 'Beta LLC' });
    expect(
      normalizeAllocatedProject({
        id: 'hub-3',
        name: 'Portal',
        client: { name: 'Nested Client LLC' },
      })
    ).toEqual({ id: 'hub-3', name: 'Portal', clientName: 'Nested Client LLC' });
  });

  it('enriches projects with client_name from GET /api/projects index', () => {
    const index = parseProjectClientNameIndex({
      success: true,
      data: [
        { id: 'hub-a', name: 'Alpha', client_name: 'Acme Corp' },
        { id: 'hub-b', name: 'Beta', client_name: 'Beta LLC' },
      ],
    });
    expect(index.get('hub-a')).toBe('Acme Corp');
    const enriched = enrichAllocatedProjectsWithClientNames(
      [
        { id: 'hub-a', name: 'Alpha' },
        { id: 'hub-b', name: 'Beta', clientName: 'Existing' },
      ],
      index
    );
    expect(enriched[0].clientName).toBe('Acme Corp');
    expect(enriched[1].clientName).toBe('Existing');
  });
});

describe('fetchAllocatedProjectsForUser', () => {
  const projectsIndexEmpty = (): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: [] }),
    }) as Response;

  const isProjectsIndexUrl = (href: string): boolean =>
    /\/api\/projects$/.test(href.replace(/\?.*$/, ''));

  const projectsDetailEmpty = (): Response =>
    ({
      ok: false,
      status: 404,
      json: async () => ({ success: false }),
    }) as Response;

  const isProjectsDetailUrl = (href: string): boolean => {
    const path = href.replace(/\?.*$/, '');
    return /\/api\/projects\/[^/]+$/.test(path) && !path.endsWith('/api/projects/list');
  };

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
      if (isProjectsIndexUrl(href)) {
        return projectsIndexEmpty();
      }
      if (isProjectsDetailUrl(href)) {
        return projectsDetailEmpty();
      }
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
      if (isProjectsIndexUrl(href)) {
        return projectsIndexEmpty();
      }
      if (isProjectsDetailUrl(href)) {
        return projectsDetailEmpty();
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
      if (isProjectsIndexUrl(href)) {
        return projectsIndexEmpty();
      }
      if (isProjectsDetailUrl(href)) {
        return projectsDetailEmpty();
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
      if (isProjectsIndexUrl(href)) {
        return projectsIndexEmpty();
      }
      if (isProjectsDetailUrl(href)) {
        return projectsDetailEmpty();
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
      if (isProjectsIndexUrl(href)) {
        return projectsIndexEmpty();
      }
      if (isProjectsDetailUrl(href)) {
        return projectsDetailEmpty();
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

  it('enriches list projects with client_name from GET /api/projects', async () => {
    const { fetchAllocatedProjectsForUser } = await import('../../main/hub/hub-allocations');
    const fetchFn = async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/api/projects/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [{ id: 'hub-1', title: 'Portal' }],
          }),
        } as Response;
      }
      if (isProjectsIndexUrl(href)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [{ id: 'hub-1', name: 'Portal', client_name: 'Acme Corp' }],
          }),
        } as Response;
      }
      throw new Error(`unexpected url ${href}`);
    };
    const projects = await fetchAllocatedProjectsForUser({
      token: 'tok',
      email: 'me@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(projects).toEqual([{ id: 'hub-1', name: 'Portal', clientName: 'Acme Corp' }]);
  });

  it('enriches via GET /api/projects/:id when org index is empty', async () => {
    const { fetchAllocatedProjectsForUser } = await import('../../main/hub/hub-allocations');
    const fetchFn = async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/api/projects/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [{ id: 'hub-9', title: 'Portal' }],
          }),
        } as Response;
      }
      if (isProjectsIndexUrl(href)) {
        return projectsIndexEmpty();
      }
      if (href.endsWith('/api/projects/hub-9')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { id: 'hub-9', name: 'Portal', client_name: 'Detail Client' },
          }),
        } as Response;
      }
      throw new Error(`unexpected url ${href}`);
    };
    const projects = await fetchAllocatedProjectsForUser({
      token: 'tok',
      email: 'detail@york.ie',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(projects).toEqual([{ id: 'hub-9', name: 'Portal', clientName: 'Detail Client' }]);
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
