/**
 * Read-only xyflow canvas for Summary Tree nodes (Document / L2 / L1 / Source).
 */
import { useCallback, useEffect, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  SummaryTreeGraph,
  SummaryTreeNode,
  SummaryTreeNodeKind,
} from '../../../shared/summary-tree';
import { kindLabel } from '../../../shared/summary-tree';
import './summaryTreeCanvas.css';

export const KIND_COLOR: Record<SummaryTreeNodeKind, string> = {
  source: '#f59e0b',
  l1: '#3b82f6',
  l2: '#14b8a6',
  document: '#a855f7',
};

type StNodeData = {
  kind: SummaryTreeNodeKind;
  label: string;
  title: string;
};

function SummaryDotNode({ data, selected }: NodeProps<Node<StNodeData, 'summaryDot'>>) {
  const color = KIND_COLOR[data.kind] || '#888';
  const size = data.kind === 'document' ? 18 : data.kind === 'l2' ? 14 : data.kind === 'l1' ? 11 : 7;
  return (
    <div
      className={`summary-tree-dot ${selected ? 'selected' : ''}`}
      title={`${kindLabel(data.kind)}: ${data.title}`}
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: selected ? `0 0 0 3px color-mix(in srgb, ${color} 40%, transparent)` : undefined,
      }}
    />
  );
}

const nodeTypes = { summaryDot: SummaryDotNode };

function toFlow(graph: SummaryTreeGraph, selectedId: string | null): {
  nodes: Node<StNodeData, 'summaryDot'>[];
  edges: Edge[];
} {
  const nodes: Node<StNodeData, 'summaryDot'>[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'summaryDot' as const,
    position: { x: n.x, y: n.y },
    selected: n.id === selectedId,
    data: {
      kind: n.kind,
      label: kindLabel(n.kind),
      title: n.title,
    },
  }));
  const edges: Edge[] = graph.links.map((l) => ({
    id: l.id,
    source: l.from,
    target: l.to,
    selectable: false,
    focusable: false,
  }));
  return { nodes, edges };
}

function CanvasInner({
  graph,
  selectedId,
  onSelect,
}: {
  graph: SummaryTreeGraph;
  selectedId: string | null;
  onSelect: (node: SummaryTreeNode | null) => void;
}) {
  const mapped = useMemo(() => toFlow(graph, selectedId), [graph, selectedId]);
  const [nodes, setNodes] = useNodesState(mapped.nodes);
  const [edges, setEdges] = useEdgesState(mapped.edges);

  useEffect(() => {
    setNodes(mapped.nodes);
    setEdges(mapped.edges);
  }, [mapped, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const full = graph.nodes.find((n) => n.id === node.id) || null;
      onSelect(full);
    },
    [graph.nodes, onSelect]
  );

  return (
    <div className="summary-tree-canvas h-[360px] w-full sm:h-[420px]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border-muted)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function SummaryTreeGraphView(props: {
  graph: SummaryTreeGraph;
  selectedId: string | null;
  onSelect: (node: SummaryTreeNode | null) => void;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
