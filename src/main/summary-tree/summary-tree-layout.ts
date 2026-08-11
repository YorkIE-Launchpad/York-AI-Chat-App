/**
 * Deterministic layout for summary tree nodes (vertical forest).
 */
import type { SummaryTreeNode } from '../../shared/summary-tree';

const LEVEL_GAP_Y = 110;
const SIBLING_GAP_X = 148;
const TREE_GAP_X = 80;

/**
 * Assign stable x/y positions: each document tree laid out top-down.
 * Documents at the top, sources at the bottom — readable next to labeled chips.
 */
export function layoutSummaryTreeNodes(nodes: SummaryTreeNode[]): SummaryTreeNode[] {
  if (nodes.length === 0) return [];

  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const n of byId.values()) {
    if (!n.parentId) {
      roots.push(n.id);
    } else {
      const list = children.get(n.parentId) || [];
      list.push(n.id);
      children.set(n.parentId, list);
    }
  }

  for (const [pid, kids] of children) {
    kids.sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      return na.title.localeCompare(nb.title);
    });
    children.set(pid, kids);
  }
  roots.sort((a, b) => byId.get(a)!.title.localeCompare(byId.get(b)!.title));

  /** Subtree width in sibling units (leaf = 1). */
  const subtreeWidth = (id: string): number => {
    const kids = children.get(id) || [];
    if (kids.length === 0) return 1;
    return Math.max(
      1,
      kids.reduce((sum, kid) => sum + subtreeWidth(kid), 0)
    );
  };

  let forestOffsetX = 0;

  const place = (id: string, centerX: number, depth: number) => {
    const node = byId.get(id)!;
    node.x = centerX;
    node.y = depth * LEVEL_GAP_Y;

    const kids = children.get(id) || [];
    if (kids.length === 0) return;

    const widths = kids.map(subtreeWidth);
    const total = widths.reduce((a, b) => a + b, 0);
    let cursor = centerX - ((total - 1) * SIBLING_GAP_X) / 2;

    kids.forEach((kid, i) => {
      const w = widths[i];
      const kidCenter = cursor + ((w - 1) * SIBLING_GAP_X) / 2;
      place(kid, kidCenter, depth + 1);
      cursor += w * SIBLING_GAP_X;
    });
  };

  for (const rootId of roots) {
    const widthUnits = subtreeWidth(rootId);
    const span = Math.max(1, widthUnits - 1) * SIBLING_GAP_X;
    const centerX = forestOffsetX + span / 2;
    place(rootId, centerX, 0);
    forestOffsetX += span + TREE_GAP_X + SIBLING_GAP_X;
  }

  return [...byId.values()];
}
