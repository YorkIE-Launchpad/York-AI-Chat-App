/**
 * Editable WorkflowGraph canvas (OpenHuman FlowCanvas-aligned, York node kinds).
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './workflowCanvas.css';

import type {
  WorkflowGraph,
  WorkflowNodeType,
  WorkflowRunStep,
  WorkflowRunStepStatus,
} from '../../../../shared/workflows';
import {
  workflowGraphToFlow,
  type FlowCanvasNodeData,
} from '../../../../shared/workflow-graph-xyflow';
import {
  addNode,
  connectNodes,
  disconnectEdge,
  removeNode,
  setNodePosition,
} from '../../../../shared/workflow-graph-edit';
import { NodePalette } from './NodePalette';
import { WorkflowFlowNode, type WorkflowFlowNodeType } from './WorkflowFlowNode';

const nodeTypes = { workflow: WorkflowFlowNode };

function stepsToStatusMap(
  steps: WorkflowRunStep[] | undefined
): Record<string, WorkflowRunStepStatus> | undefined {
  if (!steps?.length) return undefined;
  const map: Record<string, WorkflowRunStepStatus> = {};
  for (const s of steps) {
    map[s.nodeId] = s.status;
  }
  return map;
}

function flowNodesFromGraph(
  graph: WorkflowGraph,
  selectedNodeId: string | null | undefined,
  steps: WorkflowRunStep[] | undefined
): Node<FlowCanvasNodeData>[] {
  const flow = workflowGraphToFlow(graph, {
    selectedNodeId,
    stepStatusByNodeId: stepsToStatusMap(steps),
  });
  return flow.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    selected: n.selected,
    data: n.data,
  }));
}

function flowEdgesFromGraph(graph: WorkflowGraph): Edge[] {
  const flow = workflowGraphToFlow(graph);
  return flow.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    deletable: true,
    selectable: true,
  }));
}

function CanvasInner({
  graph,
  selectedNodeId,
  runSteps,
  editable,
  busy,
  onSelectNode,
  onGraphChange,
  onError,
}: {
  graph: WorkflowGraph;
  selectedNodeId?: string | null;
  runSteps?: WorkflowRunStep[];
  editable?: boolean;
  busy?: boolean;
  onSelectNode: (id: string | null) => void;
  onGraphChange: (graph: WorkflowGraph) => void;
  onError?: (message: string) => void;
}) {
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const [nodes, setNodes] = useNodesState<WorkflowFlowNodeType>(
    flowNodesFromGraph(graph, selectedNodeId, runSteps) as WorkflowFlowNodeType[]
  );
  const [edges, setEdges] = useEdgesState(flowEdgesFromGraph(graph));

  // Sync external graph / selection / run status into React Flow
  useEffect(() => {
    setNodes(flowNodesFromGraph(graph, selectedNodeId, runSteps) as WorkflowFlowNodeType[]);
    setEdges(flowEdgesFromGraph(graph));
  }, [graph, selectedNodeId, runSteps, setNodes, setEdges]);

  const emitGraph = useCallback(
    (next: WorkflowGraph) => {
      onGraphChange(next);
    },
    [onGraphChange]
  );

  const onNodesChange: OnNodesChange<WorkflowFlowNodeType> = useCallback(
    (changes: NodeChange<WorkflowFlowNodeType>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      if (!editable || busy) return;

      let next = graphRef.current;
      let changed = false;
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          // Drag finished — persist position
          next = setNodePosition(next, change.id, change.position.x, change.position.y);
          changed = true;
        }
        if (change.type === 'remove') {
          try {
            next = removeNode(next, change.id);
            changed = true;
            if (selectedNodeId === change.id) onSelectNode(null);
          } catch (err) {
            onError?.(err instanceof Error ? err.message : String(err));
          }
        }
        if (change.type === 'select' && change.selected) {
          onSelectNode(change.id);
        }
      }
      if (changed) emitGraph(next);
    },
    [busy, editable, emitGraph, onError, onSelectNode, selectedNodeId, setNodes]
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
      if (!editable || busy) return;
      let next = graphRef.current;
      let changed = false;
      for (const change of changes) {
        if (change.type === 'remove') {
          try {
            next = disconnectEdge(next, change.id);
            changed = true;
          } catch (err) {
            onError?.(err instanceof Error ? err.message : String(err));
          }
        }
      }
      if (changed) emitGraph(next);
    },
    [busy, editable, emitGraph, onError, setEdges]
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!editable || busy) return;
      if (!connection.source || !connection.target) return;
      try {
        const next = connectNodes(graphRef.current, connection.source, connection.target);
        setEdges((eds) => addEdge({ ...connection, id: `e_${connection.source}_${connection.target}` }, eds));
        emitGraph(next);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : String(err));
      }
    },
    [busy, editable, emitGraph, onError, setEdges]
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectNode(node.id);
    },
    [onSelectNode]
  );

  const onPaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  const handleAdd = useCallback(
    (type: Exclude<WorkflowNodeType, 'trigger'>) => {
      if (!editable || busy) return;
      try {
        const next = addNode(graphRef.current, type, {
          connectFromId: selectedNodeId || null,
          position: {
            x: 120 + graphRef.current.nodes.length * 36,
            y: 100 + (graphRef.current.nodes.length % 4) * 48,
          },
        });
        const added = next.nodes.find((n) => !graphRef.current.nodes.some((o) => o.id === n.id));
        emitGraph(next);
        if (added) onSelectNode(added.id);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : String(err));
      }
    },
    [busy, editable, emitGraph, onError, onSelectNode, selectedNodeId]
  );

  return (
    <div className="flex min-h-[360px] overflow-hidden rounded-2xl border border-border-muted bg-background-secondary/30 sm:min-h-[420px]">
      {editable ? <NodePalette disabled={busy} onAdd={handleAdd} /> : null}
      <div className="workflow-graph-canvas relative min-h-[360px] flex-1 sm:min-h-[420px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodesDraggable={Boolean(editable) && !busy}
          nodesConnectable={Boolean(editable) && !busy}
          elementsSelectable
          edgesReconnectable={false}
          deleteKeyCode={editable && !busy ? ['Backspace', 'Delete'] : null}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.35}
          maxZoom={1.5}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border-muted)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

export function WorkflowGraphCanvas(props: {
  graph: WorkflowGraph;
  selectedNodeId?: string | null;
  runSteps?: WorkflowRunStep[];
  editable?: boolean;
  busy?: boolean;
  onSelectNode: (id: string | null) => void;
  onGraphChange: (graph: WorkflowGraph) => void;
  onError?: (message: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
