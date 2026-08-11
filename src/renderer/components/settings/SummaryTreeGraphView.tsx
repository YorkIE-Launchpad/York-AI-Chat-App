/**
 * Read-only xyflow canvas for Summary Tree nodes (Document / L2 / L1 / Source).
 */
import { useCallback, useEffect, useMemo, type CSSProperties } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
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

function truncateTitle(title: string, max: number): string {
  const t = title.trim() || 'Untitled';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function SummaryTreeFlowNode({ data, selected }: NodeProps<Node<StNodeData, 'summaryTree'>>) {
  const color = KIND_COLOR[data.kind] || '#888';
  const isSource = data.kind === 'source';
  const titleMax = data.kind === 'document' ? 28 : data.kind === 'source' ? 18 : 22;

  return (
    <div
      className={`summary-tree-node summary-tree-node--${data.kind}${selected ? ' selected' : ''}`}
      title={`${kindLabel(data.kind)}: ${data.title}`}
      style={
        {
          '--st-kind': color,
        } as CSSProperties
      }
    >
      <Handle type="target" position={Position.Top} className="summary-tree-handle" />
      <span className="summary-tree-node__dot" aria-hidden />
      <span className="summary-tree-node__text">
        {!isSource ? (
          <span className="summary-tree-node__kind">{data.label}</span>
        ) : null}
        <span className="summary-tree-node__title">{truncateTitle(data.title, titleMax)}</span>
      </span>
      <Handle type="source" position={Position.Bottom} className="summary-tree-handle" />
    </div>
  );
}

const nodeTypes = { summaryTree: SummaryTreeFlowNode };

function toFlow(graph: SummaryTreeGraph, selectedId: string | null): {
  nodes: Node<StNodeData, 'summaryTree'>[];
  edges: Edge[];
} {
  const nodes: Node<StNodeData, 'summaryTree'>[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'summaryTree' as const,
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
  const { fitView } = useReactFlow();

  useEffect(() => {
    setNodes(mapped.nodes);
    setEdges(mapped.edges);
  }, [mapped, setNodes, setEdges]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      void fitView({ padding: 0.18, duration: 200 });
    });
    return () => cancelAnimationFrame(id);
  }, [graph.nodes, graph.links, fitView]);

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
        fitViewOptions={{ padding: 0.18 }}
        nodeOrigin={[0.5, 0]}
        proOptions={{ hideAttribution: true }}
        minZoom={0.12}
        maxZoom={1.75}
        defaultEdgeOptions={{
          type: 'smoothstep',
          style: { strokeWidth: 1.25 },
        }}
      >
        <Background variant={BackgroundVariant.Lines} gap={22} size={1} color="var(--border-muted)" />
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
