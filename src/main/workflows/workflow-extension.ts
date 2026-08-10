/**
 * Agent tools for proposing/listing workflows (OpenHuman-inspired).
 * Authoring only in user chats — never while a workflow agent step is executing.
 * propose validates by default; save:true required to persist a draft.
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type {
  WorkflowBinding,
  WorkflowGraph,
  WorkflowNode,
  WorkflowEdge,
} from '../../shared/workflows';
import {
  WORKFLOW_SCHEMA_VERSION,
  isWorkflowAgentExecutionContext,
} from '../../shared/workflows';
import {
  buildWorkflowFromDescription,
  buildWorkflowFromGraphInput,
  WorkflowGraphValidationError,
} from './workflow-build';
import type { WorkflowService } from './workflow-service';

function formatDraftSummary(
  draft: { id: string; name: string; division: string; graph: { nodes: WorkflowNode[] } },
  summary: string[],
  reused: boolean
): string {
  return [
    reused
      ? `Reused existing draft (status: draft — not enabled).`
      : `Draft workflow saved (status: draft — not enabled).`,
    `id: ${draft.id}`,
    `name: ${draft.name}`,
    `workspace: ${draft.division}`,
    `structure: ${summary.join(' → ')}`,
    `nodes: ${draft.graph.nodes.map((n) => `${n.id}(${n.type})`).join(' → ')}`,
    'Open the Workflows panel from the sidebar to review, edit workspace binding, enable, or run.',
    'Enable will arm any cron trigger as a real schedule that runs this workflow.',
  ].join('\n');
}

function formatPreviewSummary(
  name: string,
  summary: string[],
  nodes: WorkflowNode[]
): string {
  return [
    `Validated workflow graph (not saved). Pass save:true only if the user asked to keep a draft.`,
    `name: ${name}`,
    `structure: ${summary.join(' → ')}`,
    `nodes: ${nodes.map((n) => `${n.id}(${n.type})`).join(' → ')}`,
  ].join('\n');
}

function parseBinding(params: Record<string, unknown>): Partial<WorkflowBinding> | null {
  if (!params.division && !params.hub_project_id && !params.folder_id) return null;
  return {
    division: (params.division as WorkflowBinding['division']) || 'general',
    hubProjectId: (params.hub_project_id as string) || null,
    hubProjectName: (params.hub_project_name as string) || null,
    launchpadProjectId:
      typeof params.launchpad_project_id === 'number' ? params.launchpad_project_id : null,
    launchpadProjectName: (params.launchpad_project_name as string) || null,
    folderId: (params.folder_id as string) || null,
    folderName: (params.folder_name as string) || null,
    canonicalKey: (params.canonical_key as string) || null,
  };
}

export function createWorkflowTools(workflowService: WorkflowService): AgentRuntimeCustomTool[] {
  const proposeTool: AgentRuntimeCustomTool = {
    name: 'workflow_propose',
    label: 'workflow_propose',
    description: [
      'Propose or validate a durable automation workflow.',
      'ONLY call when the user explicitly asks to create, set up, automate, or save a workflow.',
      'Never call proactively, on app launch, while briefing, or while executing another workflow.',
      'Default is validation-only (does not write). Pass save:true to persist a DRAFT — never enables.',
      'Optional workspace binding: division general|hub|project|folder plus hub_project_id / folder_id when relevant.',
      'Prefer name + structured graph. Prose-only: pass description.',
    ].join(' '),
    parameters: Type.Object({
      description: Type.Optional(
        Type.String({
          minLength: 3,
          description: 'Natural-language automation request when graph is not provided.',
        })
      ),
      name: Type.Optional(
        Type.String({
          description: 'Short human title (required when graph is provided).',
        })
      ),
      graph: Type.Optional(
        Type.Object({
          nodes: Type.Array(Type.Any()),
          edges: Type.Array(Type.Any()),
        })
      ),
      require_approval: Type.Optional(
        Type.Boolean({
          description: 'Default true — inject approval gate if missing from graph.',
        })
      ),
      save: Type.Optional(
        Type.Boolean({
          description:
            'If true, persist as a draft. Default false. Only true when the user asked to save/create.',
        })
      ),
      division: Type.Optional(
        Type.String({ description: 'Workspace: general | hub | project | folder' })
      ),
      hub_project_id: Type.Optional(Type.String()),
      hub_project_name: Type.Optional(Type.String()),
      launchpad_project_id: Type.Optional(Type.Number()),
      launchpad_project_name: Type.Optional(Type.String()),
      folder_id: Type.Optional(Type.String()),
      folder_name: Type.Optional(Type.String()),
      canonical_key: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const p = params as {
        description?: string;
        name?: string;
        graph?: { nodes?: unknown[]; edges?: unknown[] };
        require_approval?: boolean;
        save?: boolean;
        division?: string;
        hub_project_id?: string;
        hub_project_name?: string;
        launchpad_project_id?: number;
        launchpad_project_name?: string;
        folder_id?: string;
        folder_name?: string;
        canonical_key?: string;
      };
      const save = p.save === true;
      const binding = parseBinding(p as Record<string, unknown>);

      try {
        if (p.graph?.nodes && p.graph?.edges && p.name?.trim()) {
          const graph: WorkflowGraph = {
            version: WORKFLOW_SCHEMA_VERSION,
            nodes: p.graph.nodes as WorkflowNode[],
            edges: (p.graph.edges as WorkflowEdge[]).map((e, i) => ({
              id: e.id || `e_${i}`,
              from: e.from,
              to: e.to,
            })),
          };
          const built = buildWorkflowFromGraphInput({
            name: p.name.trim(),
            description: p.description,
            graph,
            requireApproval: p.require_approval !== false,
          });
          if (!save) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatPreviewSummary(
                    built.input.name,
                    built.summary,
                    built.input.graph.nodes
                  ),
                },
              ],
              details: built.input,
            };
          }
          const result = workflowService.proposeFromGraph({
            name: p.name.trim(),
            description: p.description,
            graph,
            requireApproval: p.require_approval !== false,
            binding,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: formatDraftSummary(result.workflow, result.summary, result.reused),
              },
            ],
            details: result.workflow,
          };
        }

        const description = String(p.description || p.name || '').trim();
        if (description.length < 3) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Provide description (prose) or name+graph (structured). Graph needs name, nodes[], edges[].',
              },
            ],
            details: undefined,
          };
        }

        if (!save) {
          const built = buildWorkflowFromDescription(description);
          return {
            content: [
              {
                type: 'text' as const,
                text: formatPreviewSummary(
                  built.input.name,
                  built.summary,
                  built.input.graph.nodes
                ),
              },
            ],
            details: built.input,
          };
        }

        const result = await workflowService.proposeFromDescription(description, { binding });
        const summary = result.workflow.graph.nodes.map((n) => {
          if (n.type === 'trigger') return `trigger:${n.trigger}`;
          return n.type;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: formatDraftSummary(result.workflow, summary, result.reused),
            },
          ],
          details: result.workflow,
        };
      } catch (error) {
        const message =
          error instanceof WorkflowGraphValidationError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Workflow proposal failed validation: ${message}. Fix the graph/description and try again.`,
            },
          ],
          details: undefined,
        };
      }
    },
  };

  const listTool: AgentRuntimeCustomTool = {
    name: 'workflow_list',
    label: 'workflow_list',
    description:
      'List saved visual workflows and their status. Do not call workflow_propose unless the user asks to create one.',
    parameters: Type.Object({}),
    async execute() {
      const items = workflowService.list();
      if (!items.length) {
        return {
          content: [{ type: 'text' as const, text: 'No workflows saved yet.' }],
          details: undefined,
        };
      }
      const lines = items.map((w) => {
        const trigger = w.graph.nodes.find((n) => n.type === 'trigger');
        const trig =
          trigger && trigger.type === 'trigger'
            ? `${trigger.trigger}${trigger.cron?.times ? `@${trigger.cron.times.join(',')}` : ''}`
            : 'none';
        return `- ${w.id}: ${w.name} [${w.status}] workspace=${w.division} trigger=${trig} nodes=${w.graph.nodes.length}`;
      });
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
    prompt,
  }: Parameters<NonNullable<AgentRuntimeExtension['beforeSessionRun']>>[0]): Promise<BeforeSessionRunResult | void> {
    if (session.incognito) return;
    if (
      isWorkflowAgentExecutionContext({
        title: session.title,
        prompt,
      })
    ) {
      return;
    }
    return {
      customTools: createWorkflowTools(this.workflowService),
    };
  }
}
