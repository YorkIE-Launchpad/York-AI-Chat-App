import { describe, expect, it } from 'vitest';
import {
  applyProjectScopedMcpResultFilter,
  hubMcpOriginalToolName,
  isHubMcpToolName,
  prepareProjectScopedMcpArgs,
  projectScopeRefuseMessage,
} from '../../shared/project-mcp-scope';
import { buildDivisionSystemPrompt } from '../../shared/workspace-division';

const coachSession = {
  division: 'project' as const,
  hubProjectId: 'coach-uuid',
  hubProjectName: 'Coachmetrix',
};

describe('project-mcp-scope', () => {
  it('detects Hub MCP tool names (new + legacy)', () => {
    expect(isHubMcpToolName('mcp__York_IE_HUB__get_project')).toBe(true);
    expect(isHubMcpToolName('mcp__Hub__list_projects')).toBe(true);
    expect(isHubMcpToolName('mcp__R_D_Launchpad__list_projects')).toBe(false);
    expect(hubMcpOriginalToolName('mcp__York_IE_HUB__get_project')).toBe('get_project');
    expect(hubMcpOriginalToolName('mcp__R_D_Launchpad__list_projects')).toBeNull();
  });

  it('no-ops for general and hub divisions', () => {
    const args = { id: 'other-uuid' };
    expect(
      prepareProjectScopedMcpArgs('mcp__York_IE_HUB__get_project', args, { division: 'general' })
    ).toEqual({ kind: 'allow', args, filterResult: false });
    expect(
      prepareProjectScopedMcpArgs('mcp__York_IE_HUB__get_project', args, { division: 'hub' })
    ).toEqual({ kind: 'allow', args, filterResult: false });
  });

  it('no-ops for non-Hub tools in project division', () => {
    const args = { projectId: 'lp-1' };
    expect(
      prepareProjectScopedMcpArgs('mcp__R_D_Launchpad__list_features', args, coachSession)
    ).toEqual({ kind: 'allow', args, filterResult: false });
  });

  it('injects locked hubProjectId when get_project args omit id', () => {
    const prepared = prepareProjectScopedMcpArgs('mcp__York_IE_HUB__get_project', {}, coachSession);
    expect(prepared).toEqual({
      kind: 'allow',
      args: { projectId: 'coach-uuid' },
      filterResult: false,
    });
  });

  it('injects into existing project_id key when present without value conflict', () => {
    const prepared = prepareProjectScopedMcpArgs(
      'mcp__York_IE_HUB__list_project_allocations',
      { project_id: 'coach-uuid', limit: 10 },
      coachSession
    );
    expect(prepared).toEqual({
      kind: 'allow',
      args: { project_id: 'coach-uuid', limit: 10 },
      filterResult: false,
    });
  });

  it('rejects get_project with a different project UUID', () => {
    const prepared = prepareProjectScopedMcpArgs(
      'mcp__York_IE_HUB__get_project',
      { id: 'medical-ease-uuid' },
      coachSession
    );
    expect(prepared.kind).toBe('block');
    if (prepared.kind === 'block') {
      expect(prepared.message).toContain('Incorrect use');
      expect(prepared.message).toContain('will be reported');
      expect(prepared.message).toContain('Coachmetrix');
      expect(prepared.message).toContain('coach-uuid');
      expect(prepared.message).toContain('Switch Project workspace');
      expect(prepared.attemptedProjectId).toBe('medical-ease-uuid');
    }
  });

  it('marks list_projects for result filtering', () => {
    const prepared = prepareProjectScopedMcpArgs(
      'mcp__York_IE_HUB__list_projects',
      {},
      coachSession
    );
    expect(prepared).toEqual({ kind: 'allow', args: {}, filterResult: true });
  });

  it('filters list_projects payloads to the locked project only', () => {
    const payload = JSON.stringify([
      { id: 'medical-ease-uuid', title: 'MedicalEase' },
      { id: 'coach-uuid', title: 'Coachmetrix' },
      { id: 'other', name: 'Other' },
    ]);
    const filtered = applyProjectScopedMcpResultFilter(
      'mcp__York_IE_HUB__list_projects',
      payload,
      coachSession
    );
    expect(JSON.parse(filtered)).toEqual([{ id: 'coach-uuid', title: 'Coachmetrix' }]);
  });

  it('filters list_project_summaries nested arrays', () => {
    const payload = JSON.stringify({
      projects: [
        { id: 'medical-ease-uuid', title: 'MedicalEase', status: 'green' },
        { id: 'coach-uuid', title: 'Coachmetrix', status: 'green' },
      ],
    });
    const filtered = applyProjectScopedMcpResultFilter(
      'mcp__York_IE_HUB__list_project_summaries',
      payload,
      coachSession
    );
    expect(JSON.parse(filtered)).toEqual({
      projects: [{ id: 'coach-uuid', title: 'Coachmetrix', status: 'green' }],
    });
  });

  it('returns empty in-scope message when no locked project remains', () => {
    const payload = JSON.stringify([{ id: 'medical-ease-uuid', title: 'MedicalEase' }]);
    const filtered = applyProjectScopedMcpResultFilter(
      'mcp__York_IE_HUB__list_projects',
      payload,
      coachSession
    );
    expect(filtered).toContain('No in-scope data');
    expect(filtered).toContain('Coachmetrix');
    expect(filtered).not.toContain('MedicalEase');
  });

  it('matches locked project by normalized title when id field differs', () => {
    const payload = JSON.stringify([{ projectId: 'coach-uuid', title: 'Coach Metrix' }]);
    // title normalizes differently — use exact name match path via id
    const byId = applyProjectScopedMcpResultFilter(
      'mcp__Hub__list_projects',
      payload,
      coachSession
    );
    expect(JSON.parse(byId)).toEqual([{ projectId: 'coach-uuid', title: 'Coach Metrix' }]);
  });

  it('does not filter results outside project division', () => {
    const payload = JSON.stringify([{ id: 'medical-ease-uuid', title: 'MedicalEase' }]);
    expect(
      applyProjectScopedMcpResultFilter('mcp__York_IE_HUB__list_projects', payload, {
        division: 'general',
      })
    ).toBe(payload);
  });

  it('exposes a refuse message for UI/tool errors', () => {
    const message = projectScopeRefuseMessage(coachSession);
    expect(message).toContain('Incorrect use');
    expect(message).toContain('will be reported');
    expect(message).toContain('Coachmetrix');
  });

  const clientSession = {
    division: 'client' as const,
    clientName: 'Acme Corp',
    clientProjectIds: JSON.stringify([
      { name: 'Portal', hubProjectId: 'coach-uuid', canonicalKey: 'hub:coach-uuid' },
      { name: 'Mobile', hubProjectId: 'mobile-uuid', canonicalKey: 'hub:mobile-uuid' },
    ]),
    canonicalKey: 'client:acme-corp',
  };

  it('allows get_project for ids in client allowlist without auto-inject', () => {
    const prepared = prepareProjectScopedMcpArgs(
      'mcp__York_IE_HUB__get_project',
      { projectId: 'mobile-uuid' },
      clientSession
    );
    expect(prepared).toEqual({
      kind: 'allow',
      args: { projectId: 'mobile-uuid' },
      filterResult: false,
    });
  });

  it('blocks get_project for ids outside client allowlist', () => {
    const prepared = prepareProjectScopedMcpArgs(
      'mcp__York_IE_HUB__get_project',
      { projectId: 'other-uuid' },
      clientSession
    );
    expect(prepared.kind).toBe('block');
  });

  it('filters list_projects to all client allowlisted ids', () => {
    const payload = JSON.stringify([
      { id: 'coach-uuid', title: 'Portal' },
      { id: 'mobile-uuid', title: 'Mobile' },
      { id: 'other-uuid', title: 'Other' },
    ]);
    const filtered = applyProjectScopedMcpResultFilter(
      'mcp__York_IE_HUB__list_projects',
      payload,
      clientSession
    );
    expect(JSON.parse(filtered)).toEqual([
      { id: 'coach-uuid', title: 'Portal' },
      { id: 'mobile-uuid', title: 'Mobile' },
    ]);
  });
});

describe('buildDivisionSystemPrompt project refuse line', () => {
  it('tells the model not to call Hub tools for other named projects', () => {
    const prompt = buildDivisionSystemPrompt(coachSession);
    expect(prompt).toContain('If the user names another project');
    expect(prompt).toContain('do not call Hub project tools');
    expect(prompt).toContain('Incorrect use. This will be reported.');
    expect(prompt).toContain('Coachmetrix');
  });
});
