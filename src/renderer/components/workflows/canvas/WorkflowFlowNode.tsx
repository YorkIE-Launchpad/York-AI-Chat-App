/**
 * Custom @xyflow node for WorkflowGraph node kinds.
 */
import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { FlowCanvasNodeData } from '../../../../shared/workflow-graph-xyflow';
import { stepStatusDotClass } from '../WorkflowRunStatus';
import { NODE_META } from './nodeMeta';

export type WorkflowFlowNodeType = Node<FlowCanvasNodeData, 'workflow'>;

function WorkflowFlowNodeInner({ data, selected }: NodeProps<WorkflowFlowNodeType>) {
  const meta = NODE_META[data.nodeType] || NODE_META.agent;
  const Icon = meta.icon;
  const runStatus = data.runStatus;

  return (
    <div
      className={`workflow-flow-node rounded-2xl border bg-background px-3 py-2.5 text-left shadow-soft transition ${
        selected
          ? `border-transparent selected ring-2 ${meta.ring}`
          : data.nodeType === 'approval'
            ? 'border-accent/40'
            : 'border-border-muted'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-accent" />
      <div className="flex items-start gap-2">
        <span
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.tint}`}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
              {meta.label}
            </span>
            {runStatus ? (
              <span
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${stepStatusDotClass(runStatus)}`}
                title={runStatus}
              />
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs font-medium leading-snug text-text-primary">
            {data.label}
          </p>
          {data.summary ? (
            <p className="mt-1 line-clamp-2 text-[10px] leading-3.5 text-text-muted">{data.summary}</p>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-accent" />
    </div>
  );
}

export const WorkflowFlowNode = memo(WorkflowFlowNodeInner);
