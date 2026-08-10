/**
 * Shared Summary Tree types (OpenHuman-aligned L0→L1→L2 hierarchy over wiki leaves).
 */

export type SummaryTreeNodeKind = 'document' | 'l2' | 'l1' | 'source';

/** document=3 … source=0 */
export type SummaryTreeLevel = 0 | 1 | 2 | 3;

export interface SummaryTreeNode {
  id: string;
  treeKey: string;
  kind: SummaryTreeNodeKind;
  level: SummaryTreeLevel;
  parentId: string | null;
  title: string;
  body: string;
  wikiPageId: string | null;
  score: number;
  x: number;
  y: number;
  createdAt: number;
  updatedAt: number;
}

export interface SummaryTreeLink {
  id: string;
  from: string;
  to: string;
}

export interface SummaryTreeGraph {
  nodes: SummaryTreeNode[];
  links: SummaryTreeLink[];
  /** Whether source leaves are included (UI may hide when dense). */
  includesSourceLeaves: boolean;
}

export interface SummaryTreeStats {
  nodeCount: number;
  linkCount: number;
  treeCount: number;
  sourceCount: number;
  l1Count: number;
  l2Count: number;
  documentCount: number;
}

export interface SummaryTreeBuildResult extends SummaryTreeStats {
  builtAt: number;
  wikiPageCount: number;
}

export const SUMMARY_TREE_BUCKET_L1 = 8;
export const SUMMARY_TREE_BUCKET_L2 = 4;
export const SUMMARY_TREE_WIKI_CAP = 2000;
export const SUMMARY_TREE_DISPLAY_SOURCE_THRESHOLD = 800;

export function levelForKind(kind: SummaryTreeNodeKind): SummaryTreeLevel {
  switch (kind) {
    case 'source':
      return 0;
    case 'l1':
      return 1;
    case 'l2':
      return 2;
    case 'document':
      return 3;
    default:
      return 0;
  }
}

export function kindLabel(kind: SummaryTreeNodeKind): string {
  switch (kind) {
    case 'source':
      return 'Source';
    case 'l1':
      return 'L1';
    case 'l2':
      return 'L2';
    case 'document':
      return 'Document';
    default:
      return kind;
  }
}
