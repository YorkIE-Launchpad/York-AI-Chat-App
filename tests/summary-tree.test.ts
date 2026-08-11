import { describe, expect, it } from 'vitest';
import {
  sealAllTrees,
  sealCategoryTree,
  summariseBucket,
  treeKeyFromWikiPath,
  type SummaryTreeLeafInput,
} from '../src/main/summary-tree/summary-tree-seal';
import { layoutSummaryTreeNodes } from '../src/main/summary-tree/summary-tree-layout';
import type { SummaryTreeNode } from '../src/shared/summary-tree';

function leaf(i: number, treeKey = 'clients'): SummaryTreeLeafInput {
  return {
    wikiPageId: `wiki-${i}`,
    treeKey,
    title: `Page ${i}`,
    body: `Body content for page ${i}. `.repeat(5),
    score: i,
  };
}

describe('summary-tree-seal', () => {
  it('parses tree key from wiki path', () => {
    expect(treeKeyFromWikiPath('clients/acme')).toBe('clients');
    expect(treeKeyFromWikiPath('/people/jane')).toBe('people');
    expect(treeKeyFromWikiPath('')).toBe('general');
  });

  it('extractive summarise includes titles', () => {
    const text = summariseBucket('Group', [
      { title: 'A', body: 'Alpha details here' },
      { title: 'B', body: 'Beta details here' },
    ]);
    expect(text).toContain('# Group');
    expect(text).toContain('## A');
    expect(text).toContain('Alpha');
  });

  it('seals 17 leaves into expected L1/L2 structure', () => {
    // 17 leaves, bucket L1=8 → ceil(17/8)=3 L1s; 3 L1s → L2 buckets (bucketL2=4) → 1 L2
    const leaves = Array.from({ length: 17 }, (_, i) => leaf(i + 1));
    const nodes = sealCategoryTree('clients', leaves, {
      bucketL1: 8,
      bucketL2: 4,
      now: 1_700_000_000_000,
    });
    const sources = nodes.filter((n) => n.kind === 'source');
    const l1 = nodes.filter((n) => n.kind === 'l1');
    const l2 = nodes.filter((n) => n.kind === 'l2');
    const docs = nodes.filter((n) => n.kind === 'document');

    expect(sources).toHaveLength(17);
    expect(l1).toHaveLength(3); // 8 + 8 + 1
    expect(l2).toHaveLength(1);
    expect(docs).toHaveLength(1);

    // every non-document has a parent
    for (const n of nodes) {
      if (n.kind === 'document') {
        expect(n.parentId).toBeNull();
      } else {
        expect(n.parentId).toBeTruthy();
        expect(nodes.some((p) => p.id === n.parentId)).toBe(true);
      }
    }

    // L1 parents are L2; L2 parent is document
    for (const n of l1) {
      expect(l2.some((x) => x.id === n.parentId)).toBe(true);
    }
    expect(docs[0].id).toBe(l2[0].parentId);
  });

  it('partial buckets always seal', () => {
    // 3 leaves → 1 L1 (partial), no L2 (single L1), document
    const nodes = sealCategoryTree('people', [leaf(1, 'people'), leaf(2, 'people'), leaf(3, 'people')], {
      bucketL1: 8,
      bucketL2: 4,
    });
    expect(nodes.filter((n) => n.kind === 'source')).toHaveLength(3);
    expect(nodes.filter((n) => n.kind === 'l1')).toHaveLength(1);
    expect(nodes.filter((n) => n.kind === 'l2')).toHaveLength(0);
    expect(nodes.filter((n) => n.kind === 'document')).toHaveLength(1);
    const l1 = nodes.find((n) => n.kind === 'l1')!;
    const doc = nodes.find((n) => n.kind === 'document')!;
    expect(l1.parentId).toBe(doc.id);
  });

  it('sealAllTrees groups by category', () => {
    const leaves = [leaf(1, 'clients'), leaf(2, 'clients'), leaf(3, 'meetings')];
    const nodes = sealAllTrees(leaves);
    const keys = new Set(nodes.filter((n) => n.kind === 'document').map((n) => n.treeKey));
    expect(keys).toEqual(new Set(['clients', 'meetings']));
  });
});

describe('summary-tree-layout', () => {
  it('assigns finite x/y to every node', () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leaf(i + 1));
    let nodes: SummaryTreeNode[] = sealCategoryTree('ops', leaves);
    nodes = layoutSummaryTreeNodes(nodes);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    const parentLinks = nodes.filter((n) => n.parentId).length;
    expect(parentLinks).toBe(nodes.length - 1);
  });

  it('places documents above descendants (top-down forest)', () => {
    const leaves = [
      ...Array.from({ length: 3 }, (_, i) => leaf(i + 1, 'alpha')),
      ...Array.from({ length: 3 }, (_, i) => leaf(i + 10, 'beta')),
    ];
    let nodes: SummaryTreeNode[] = sealAllTrees(leaves);
    nodes = layoutSummaryTreeNodes(nodes);

    const docs = nodes.filter((n) => n.kind === 'document');
    expect(docs.length).toBe(2);

    for (const doc of docs) {
      const kids = nodes.filter((n) => n.parentId === doc.id);
      expect(kids.length).toBeGreaterThan(0);
      for (const kid of kids) {
        expect(kid.y).toBeGreaterThan(doc.y);
      }
    }

    // Forests side-by-side: roots at distinct x
    expect(Math.abs(docs[0].x - docs[1].x)).toBeGreaterThan(50);
  });
});
