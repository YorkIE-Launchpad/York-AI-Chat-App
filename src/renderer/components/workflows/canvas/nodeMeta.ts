/**
 * Shared node chrome metadata for workflow canvas cards.
 */
import {
  Bell,
  FormInput,
  ShieldCheck,
  Sparkles,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { WorkflowNodeType } from '../../../../shared/workflows';

export const ACCENT_TINT = 'bg-accent/12 text-accent';
export const ACCENT_RING = 'ring-accent/40';

export const NODE_META: Record<
  WorkflowNodeType,
  { label: string; icon: LucideIcon; tint: string; ring: string; blurb: string }
> = {
  trigger: {
    label: 'Trigger',
    icon: Zap,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'When this automation starts',
  },
  agent: {
    label: 'Agent',
    icon: Sparkles,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'York runs this prompt with tools; later agents receive prior results',
  },
  tool: {
    label: 'Tool',
    icon: Workflow,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'Direct tool invocation',
  },
  input: {
    label: 'Input',
    icon: FormInput,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'Pause for your answers (text or choices) before continuing',
  },
  approval: {
    label: 'Approval',
    icon: ShieldCheck,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'Always requires your explicit permission',
  },
  notify: {
    label: 'Notify',
    icon: Bell,
    tint: ACCENT_TINT,
    ring: ACCENT_RING,
    blurb: 'Signal when the run finishes',
  },
};
