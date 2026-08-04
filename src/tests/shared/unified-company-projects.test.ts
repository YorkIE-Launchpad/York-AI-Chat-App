import { describe, expect, it } from 'vitest';
import {
  mergeHubAndLaunchpadProjects,
  parseLaunchPadProjectsPayload,
  hubCanonicalKey,
  launchpadCanonicalKey,
} from '../../shared/unified-company-projects';
import type { AllocatedHubProject } from '../../shared/workspace-division';
import type { LaunchPadProjectListItem } from '../../shared/unified-company-projects';

const hub = (id: string, name: string): AllocatedHubProject => ({ id, name });
const lp = (id: number, name: string, hubProjectId?: string | null): LaunchPadProjectListItem => ({
  id,
  name,
  hubProjectId: hubProjectId ?? null,
});

describe('mergeHubAndLaunchpadProjects', () => {
  it('emits hub-only when no LaunchPad match', () => {
    const merged = mergeHubAndLaunchpadProjects([hub('h1', 'Alpha')], []);
    expect(merged).toEqual([
      {
        canonicalKey: hubCanonicalKey('h1'),
        name: 'Alpha',
        sources: { hub: true },
        hubProjectId: 'h1',
        hubProjectName: 'Alpha',
      },
    ]);
  });

  it('merges hub + launchpad on LaunchPad.projectId === Hub.id', () => {
    const merged = mergeHubAndLaunchpadProjects([hub('h1', 'Alpha')], [lp(42, 'Alpha LP', 'h1')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      canonicalKey: hubCanonicalKey('h1'),
      name: 'Alpha',
      sources: { hub: true, launchpad: true },
      hubProjectId: 'h1',
      launchpadProjectId: 42,
      launchpadProjectName: 'Alpha LP',
    });
  });

  it('emits launchpad-only when no hub id', () => {
    const merged = mergeHubAndLaunchpadProjects([], [lp(7, 'Solo LP', null)]);
    expect(merged).toEqual([
      {
        canonicalKey: launchpadCanonicalKey(7),
        name: 'Solo LP',
        sources: { launchpad: true },
        hubProjectId: undefined,
        hubProjectName: undefined,
        launchpadProjectId: 7,
        launchpadProjectName: 'Solo LP',
      },
    ]);
  });

  it('emits launchpad-only when hub id not in user allocations', () => {
    const merged = mergeHubAndLaunchpadProjects(
      [hub('other', 'Other')],
      [lp(9, 'Orphan Link', 'missing-hub')]
    );
    expect(merged.map((p) => p.canonicalKey).sort()).toEqual([
      hubCanonicalKey('other'),
      launchpadCanonicalKey(9),
    ]);
    const solo = merged.find((p) => p.launchpadProjectId === 9);
    expect(solo?.sources).toEqual({ launchpad: true });
    expect(solo?.hubProjectId).toBeUndefined();
  });

  it('does not duplicate when both sources present alongside extras', () => {
    const merged = mergeHubAndLaunchpadProjects(
      [hub('h1', 'A'), hub('h2', 'B')],
      [lp(1, 'A-lp', 'h1'), lp(2, 'C-only', null)]
    );
    expect(merged).toHaveLength(3);
    expect(merged.filter((p) => p.sources.hub && p.sources.launchpad)).toHaveLength(1);
    expect(merged.filter((p) => p.sources.hub && !p.sources.launchpad)).toHaveLength(1);
    expect(merged.filter((p) => !p.sources.hub && p.sources.launchpad)).toHaveLength(1);
  });

  it('sorts by display name', () => {
    const merged = mergeHubAndLaunchpadProjects([hub('z', 'Zebra')], [lp(1, 'Apple', null)]);
    expect(merged.map((p) => p.name)).toEqual(['Apple', 'Zebra']);
  });
});

describe('parseLaunchPadProjectsPayload', () => {
  it('parses array with Hub projectId field', () => {
    const items = parseLaunchPadProjectsPayload([
      { id: 3, name: 'Foo', projectId: 'hub-abc' },
      { id: '4', name: 'Bar', hubProjectId: 'hub-def' },
    ]);
    expect(items).toEqual([
      { id: 3, name: 'Foo', hubProjectId: 'hub-abc', slug: null, isActive: undefined },
      { id: 4, name: 'Bar', hubProjectId: 'hub-def', slug: null, isActive: undefined },
    ]);
  });

  it('unwraps data envelope', () => {
    const items = parseLaunchPadProjectsPayload({
      data: [{ id: 1, name: 'X' }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(1);
  });
});
