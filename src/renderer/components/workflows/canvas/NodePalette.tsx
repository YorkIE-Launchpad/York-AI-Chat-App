/**
 * Compact palette for adding non-trigger workflow nodes to the canvas.
 */
import { Bell, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import type { WorkflowNodeType } from '../../../../shared/workflows';

const PALETTE: Array<{
  type: Exclude<WorkflowNodeType, 'trigger'>;
  label: string;
  icon: typeof Sparkles;
}> = [
  { type: 'agent', label: 'Agent', icon: Sparkles },
  { type: 'tool', label: 'Tool', icon: Workflow },
  { type: 'approval', label: 'Approval', icon: ShieldCheck },
  { type: 'notify', label: 'Notify', icon: Bell },
];

export function NodePalette({
  disabled,
  onAdd,
}: {
  disabled?: boolean;
  onAdd: (type: Exclude<WorkflowNodeType, 'trigger'>) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-r border-border-muted bg-background-secondary/50 p-2">
      <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        Add
      </p>
      {PALETTE.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.type}
            type="button"
            disabled={disabled}
            onClick={() => onAdd(item.type)}
            title={`Add ${item.label}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-muted bg-background px-2 py-1.5 text-[11px] font-medium text-text-secondary transition hover:border-border hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon className="h-3.5 w-3.5 text-accent" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
