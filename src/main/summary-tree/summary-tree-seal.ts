/**
 * Pure extractive bucket-seal for summary trees (wiki leaves → L1 → L2 → Document).
 */
import { v4 as uuidv4 } from 'uuid';
import type { WikiPage } from '../../shared/wiki';
import {
  SUMMARY_TREE_BUCKET_L1,
  SUMMARY_TREE_BUCKET_L2,
  type SummaryTreeLevel,
  type SummaryTreeNode,
  type SummaryTreeNodeKind,
  levelForKind,
} from '../../shared/summary-tree';

export interface SummaryTreeLeafInput {
  wikiPageId: string;
  treeKey: string;
  title: string;
  body: string;
  score: number;
}

export function treeKeyFromWikiPath(pagePath: string): string {
  const segment = pagePath.replace(/^\/+/, '').split('/')[0]?.trim();
  return segment && segment.length > 0 ? segment : 'general';
}

export function wikiPagesToLeaves(pages: WikiPage[]): SummaryTreeLeafInput[] {
  return pages.map((p) => ({
    wikiPageId: p.id,
    treeKey: treeKeyFromWikiPath(p.path),
    title: p.title || p.path,
    body: p.body || '',
    score: p.score ?? 0,
  }));
}

/** Extractive compress: titles + first ~400 chars per child. */
export function summariseBucket(
  title: string,
  children: Array<{ title: string; body: string }>
): string {
  const lines: string[] = [`# ${title}`, '', `Summarizes ${children.length} item(s):`, ''];
  for (const child of children) {
    const excerpt = (child.body || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    lines.push(`## ${child.title}`);
    if (excerpt) lines.push(excerpt);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out.length ? out : [[]];
}

function makeNode(input: {
  treeKey: string;
  kind: SummaryTreeNodeKind;
  parentId: string | null;
  title: string;
  body: string;
  wikiPageId?: string | null;
  score?: number;
  now?: number;
}): SummaryTreeNode {
  const now = input.now ?? Date.now();
  const level = levelForKind(input.kind) as SummaryTreeLevel;
  return {
    id: uuidv4(),
    treeKey: input.treeKey,
    kind: input.kind,
    level,
    parentId: input.parentId,
    title: input.title,
    body: input.body,
    wikiPageId: input.wikiPageId ?? null,
    score: input.score ?? 0,
    x: 0,
    y: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Seal one category tree: sources → L1 buckets → L2 buckets → document root.
 * Partial buckets always seal.
 */
export function sealCategoryTree(
  treeKey: string,
  leaves: SummaryTreeLeafInput[],
  options?: {
    bucketL1?: number;
    bucketL2?: number;
    now?: number;
  }
): SummaryTreeNode[] {
  const bucketL1 = options?.bucketL1 ?? SUMMARY_TREE_BUCKET_L1;
  const bucketL2 = options?.bucketL2 ?? SUMMARY_TREE_BUCKET_L2;
  const now = options?.now ?? Date.now();
  const sorted = [...leaves].sort((a, b) => a.title.localeCompare(b.title));

  if (sorted.length === 0) {
    return [
      makeNode({
        treeKey,
        kind: 'document',
        parentId: null,
        title: titleCaseKey(treeKey),
        body: `# ${titleCaseKey(treeKey)}\n\nNo source leaves.`,
        score: 0,
        now,
      }),
    ];
  }

  const sourceNodes = sorted.map((leaf, i) =>
    makeNode({
      treeKey,
      kind: 'source',
      parentId: null, // rewired below
      title: leaf.title,
      body: leaf.body,
      wikiPageId: leaf.wikiPageId,
      score: leaf.score,
      now: now + i,
    })
  );

  const l1Nodes: SummaryTreeNode[] = [];
  const sourceBuckets = chunkArray(sourceNodes, bucketL1);
  sourceBuckets.forEach((bucket, bi) => {
    if (bucket.length === 0) return;
    const title =
      sourceBuckets.length === 1
        ? `${titleCaseKey(treeKey)} · summary`
        : `${titleCaseKey(treeKey)} · L1 ${bi + 1}`;
    const l1 = makeNode({
      treeKey,
      kind: 'l1',
      parentId: null,
      title,
      body: summariseBucket(
        title,
        bucket.map((s) => ({ title: s.title, body: s.body }))
      ),
      score: avgScore(bucket),
      now: now + 1000 + bi,
    });
    for (const s of bucket) s.parentId = l1.id;
    l1Nodes.push(l1);
  });

  const l2Nodes: SummaryTreeNode[] = [];
  let attachToDocument: SummaryTreeNode[] = l1Nodes;

  // Multiple L1s → seal into L2 buckets; single L1 attaches directly to document.
  if (l1Nodes.length > 1) {
    attachToDocument = [];
    const l1Buckets = chunkArray(l1Nodes, bucketL2);
    l1Buckets.forEach((bucket, bi) => {
      if (bucket.length === 0) return;
      const title =
        l1Buckets.length === 1
          ? `${titleCaseKey(treeKey)} · overview`
          : `${titleCaseKey(treeKey)} · L2 ${bi + 1}`;
      const l2 = makeNode({
        treeKey,
        kind: 'l2',
        parentId: null,
        title,
        body: summariseBucket(
          title,
          bucket.map((n) => ({ title: n.title, body: n.body }))
        ),
        score: avgScore(bucket),
        now: now + 2000 + bi,
      });
      for (const n of bucket) n.parentId = l2.id;
      l2Nodes.push(l2);
      attachToDocument.push(l2);
    });
  }

  if (attachToDocument.length === 0 && l1Nodes.length > 0) {
    attachToDocument = l1Nodes;
  }

  const docTitle = titleCaseKey(treeKey);
  const document = makeNode({
    treeKey,
    kind: 'document',
    parentId: null,
    title: docTitle,
    body: summariseBucket(
      docTitle,
      attachToDocument.map((n) => ({ title: n.title, body: n.body }))
    ),
    score: avgScore(attachToDocument.length ? attachToDocument : sourceNodes),
    now: now + 3000,
  });
  for (const n of attachToDocument) n.parentId = document.id;

  return [...sourceNodes, ...l1Nodes, ...l2Nodes, document];
}

/**
 * Build all trees from leaf inputs grouped by treeKey.
 */
export function sealAllTrees(
  leaves: SummaryTreeLeafInput[],
  options?: {
    bucketL1?: number;
    bucketL2?: number;
    now?: number;
  }
): SummaryTreeNode[] {
  const byKey = new Map<string, SummaryTreeLeafInput[]>();
  for (const leaf of leaves) {
    const list = byKey.get(leaf.treeKey) || [];
    list.push(leaf);
    byKey.set(leaf.treeKey, list);
  }
  const keys = [...byKey.keys()].sort();
  const all: SummaryTreeNode[] = [];
  keys.forEach((key, i) => {
    all.push(
      ...sealCategoryTree(key, byKey.get(key) || [], {
        ...options,
        now: (options?.now ?? Date.now()) + i * 10_000,
      })
    );
  });
  return all;
}

function avgScore(nodes: Array<{ score: number }>): number {
  if (!nodes.length) return 0;
  return nodes.reduce((s, n) => s + (n.score || 0), 0) / nodes.length;
}

function titleCaseKey(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
