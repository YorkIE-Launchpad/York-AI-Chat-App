import { describe, expect, it } from 'vitest';
import { collectDescendantPids } from '../../main/utils/kill-pid-tree';

describe('collectDescendantPids', () => {
  it('walks npx → npm exec → node like mcp-remote', () => {
    const children: Record<number, number[]> = {
      100: [200],
      200: [300, 301],
      300: [],
      301: [],
    };
    expect(collectDescendantPids(100, (pid) => children[pid] ?? []).sort((a, b) => a - b)).toEqual([
      100, 200, 300, 301,
    ]);
  });

  it('ignores pid 1 and cycles', () => {
    const children: Record<number, number[]> = {
      5: [5, 1],
    };
    expect(collectDescendantPids(5, (pid) => children[pid] ?? [])).toEqual([5]);
  });
});
