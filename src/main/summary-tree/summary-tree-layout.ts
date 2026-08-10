/**
 * Deterministic layout for summary tree nodes (radial forest).
 */
import type { SummaryTreeNode } from '../../shared/summary-tree';

/**
 * Assign stable x/y positions: each document tree laid out in a radial sector.
 * Children fan around parents by kind level.
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

  // Stable child order by title
  for (const [pid, kids] of children) {
    kids.sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      return na.title.localeCompare(nb.title);
    });
    children.set(pid, kids);
  }
  roots.sort((a, b) => byId.get(a)!.title.localeCompare(byId.get(b)!.title));

  const treeKeys = [...new Set(roots.map((id) => byId.get(id)!.treeKey))];
  const forestGap = 520;
  const radiusByLevel: Record<number, number> = {
    3: 0, // document
    2: 140, // l2
    1: 240, // l1
    0: 340, // source
  };

  roots.forEach((rootId, rootIndex) => {
    const originX = rootIndex * forestGap;
    const originY = 0;

    const place = (id: string, angle: number, parentX: number, parentY: number, depth: number) => {
      const node = byId.get(id)!;
      const r = radiusByLevel[node.level] ?? 100 + depth * 80;
      if (!node.parentId) {
        node.x = originX;
        node.y = originY;
      } else {
        node.x = parentX + Math.cos(angle) * (r * 0.45 + 60);
        node.y = parentY + Math.sin(angle) * (r * 0.45 + 60);
      }

      const kids = children.get(id) || [];
      if (kids.length === 0) return;
      const span = Math.min(Math.PI * 1.4, Math.PI * 0.35 * kids.length);
      const start = angle - span / 2;
      kids.forEach((kid, i) => {
        const a =
          kids.length === 1 ? angle : start + (span * i) / Math.max(1, kids.length - 1);
        place(kid, a, node.x, node.y, depth + 1);
      });
    };

    // Start fans upward so trees don't all stack
    const baseAngle = -Math.PI / 2 + (treeKeys.indexOf(byId.get(rootId)!.treeKey) % 3) * 0.15;
    place(rootId, baseAngle, originX, originY, 0);
  });

  return [...byId.values()];
}
