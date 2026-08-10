/**
 * Agent tools for proposing/listing workflows.
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { WorkflowService } from './workflow-service';

export function createWorkflowTools(workflowService: WorkflowService): AgentRuntimeCustomTool[] {
  const proposeTool: AgentRuntimeCustomTool = {
    name: 'workflow_propose',
    label: 'workflow_propose',
    description:
      'Draft a durable visual workflow from a natural-language automation request (e.g. "automate weekday 9am Hub leave + calendar brief"). Returns a draft for the user to review in Settings → Workflows. Does not enable or run the workflow.',
    parameters: Type.Object({
      description: Type.String({
        minLength: 3,
        description: 'What to automate, including schedule and approvals when known.',
      }),
    }),
    async execute(_toolCallId, params) {
      const description = String((params as { description?: string }).description || '');
      const draft = workflowService.proposeFromDescription(description);
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Draft workflow created (status: draft).`,
              `id: ${draft.id}`,
              `name: ${draft.name}`,
              `nodes: ${draft.graph.nodes.map((n) => `${n.id}(${n.type})`).join(' → ')}`,
              'Open Settings → Workflows to review, edit, enable, or run.',
            ].join('\n'),
          },
        ],
        details: draft,
      };
    },
  };

  const listTool: AgentRuntimeCustomTool = {
    name: 'workflow_list',
    label: 'workflow_list',
    description: 'List saved visual workflows and their status.',
    parameters: Type.Object({}),
    async execute() {
      const items = workflowService.list();
      if (!items.length) {
        return {
          content: [{ type: 'text' as const, text: 'No workflows saved yet.' }],
          details: undefined,
        };
      }
      const lines = items.map(
        (w) =>
          `- ${w.id}: ${w.name} [${w.status}] nodes=${w.graph.nodes.length} updated=${new Date(w.updatedAt).toISOString()}`
      );
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: undefined,
      };
    },
  };

  return [proposeTool, listTool];
}

export class WorkflowExtension implements AgentRuntimeExtension {
  readonly name = 'workflows';

  constructor(private readonly workflowService: WorkflowService) {}

  async beforeSessionRun({
    session,
  }: Parameters<NonNullable<AgentRuntimeExtension['beforeSessionRun']>>[0]): Promise<BeforeSessionRunResult | void> {
    if (session.incognito) return;
    return {
      customTools: createWorkflowTools(this.workflowService),
    };
  }
}
