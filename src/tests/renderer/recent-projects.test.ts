import { describe, expect, it } from 'vitest';
import type { UnifiedCompanyProject } from '../../shared/unified-company-projects';
import {
  pushRecentProject,
  resolveRecentProjects,
} from '../../renderer/utils/recent-projects';

function project(key: string, name: string): UnifiedCompanyProject {
  return {
    canonicalKey: key,
    name,
    sources: { hub: true },
    hubProjectId: key.replace(/^hub:/, ''),
    hubProjectName: name,
  };
}

describe('recent-projects', () => {
  it('preprend and dedupes by canonical key, capped at limit', () => {
    let list: UnifiedCompanyProject[] = [];
    list = pushRecentProject(list, project('hub:a', 'A'));
    list = pushRecentProject(list, project('hub:b', 'B'));
    list = pushRecentProject(list, project('hub:c', 'C'));
    list = pushRecentProject(list, project('hub:d', 'D'));
    list = pushRecentProject(list, project('hub:e', 'E'));
    list = pushRecentProject(list, project('hub:f', 'F'), 5);
    expect(list.map((p) => p.canonicalKey)).toEqual([
      'hub:f',
      'hub:e',
      'hub:d',
      'hub:c',
      'hub:b',
    ]);

    list = pushRecentProject(list, project('hub:c', 'C renamed'), 5);
    expect(list.map((p) => p.canonicalKey)).toEqual([
      'hub:c',
      'hub:f',
      'hub:e',
      'hub:d',
      'hub:b',
    ]);
    expect(list[0].name).toBe('C renamed');
  });

  it('resolves recents from live catalog in recent order', () => {
    const recents = [
      project('hub:gone', 'Gone'),
      project('hub:b', 'Old B'),
      project('hub:a', 'Old A'),
    ];
    const live = [project('hub:a', 'A live'), project('hub:b', 'B live'), project('hub:c', 'C')];
    const resolved = resolveRecentProjects(recents, live);
    expect(resolved.map((p) => [p.canonicalKey, p.name])).toEqual([
      ['hub:b', 'B live'],
      ['hub:a', 'A live'],
    ]);
  });
});
