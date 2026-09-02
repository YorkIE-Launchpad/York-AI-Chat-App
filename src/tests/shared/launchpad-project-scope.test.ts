import { describe, expect, it } from 'vitest';
import {
  prepareLaunchpadScopedMcpArgs,
  applyLaunchpadScopedMcpResultFilter,
  isLaunchpadMcpToolName,
} from '../../shared/launchpad-project-scope';

const lpSession = {
  division: 'project' as const,
  launchpadProjectId: 42,
  launchpadProjectName: 'Acme LP',
};

describe('launchpad-project-scope', () => {
  it('detects launchpad MCP tool names', () => {
    expect(isLaunchpadMcpToolName('mcp__R_D_Launchpad__get_project')).toBe(true);
    expect(isLaunchpadMcpToolName('mcp__Launchpad__list_features')).toBe(true);
    expect(isLaunchpadMcpToolName('mcp__York_IE_HUB__get_project')).toBe(false);
  });

  it('passes through when no launchpad project on session', () => {
    const prepared = prepareLaunchpadScopedMcpArgs(
      'mcp__R_D_Launchpad__get_project',
      { projectId: 1 },
      { division: 'project', hubProjectId: 'h1', hubProjectName: 'H' }
    );
    expect(prepared).toEqual({ kind: 'allow', args: { projectId: 1 }, filterResult: false });
  });

  it('injects locked launchpad project id', () => {
    const prepared = prepareLaunchpadScopedMcpArgs(
      'mcp__R_D_Launchpad__get_project',
      {},
      lpSession
    );
    expect(prepared.kind).toBe('allow');
    if (prepared.kind === 'allow') {
      expect(prepared.args.projectId).toBe(42);
    }
  });

  it('blocks mismatched launchpad project id', () => {
    const prepared = prepareLaunchpadScopedMcpArgs(
      'mcp__R_D_Launchpad__get_project',
      { projectId: 99 },
      lpSession
    );
    expect(prepared.kind).toBe('block');
  });

  it('blocks client division get_project without project id', () => {
    const prepared = prepareLaunchpadScopedMcpArgs(
      'mcp__R_D_Launchpad__get_project',
      {},
      {
        division: 'client',
        clientName: 'Acme',
        clientProjectIds: JSON.stringify([
          { name: 'Acme LP', launchpadProjectId: 42, canonicalKey: 'lp:42' },
        ]),
      }
    );
    expect(prepared.kind).toBe('block');
  });

  it('filters list_project_names to allowlisted ids', () => {
    const payload = JSON.stringify([
      { projectId: 42, name: 'Acme LP' },
      { projectId: 99, name: 'Other' },
    ]);
    const filtered = applyLaunchpadScopedMcpResultFilter(
      'mcp__R_D_Launchpad__list_project_names',
      payload,
      lpSession
    );
    expect(JSON.parse(filtered)).toEqual([{ projectId: 42, name: 'Acme LP' }]);
  });
});
