/**
 * Board tools. Only attached to sessions whose kind is brainstorm.
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { BrainstormIdeaDraft } from '../../shared/brainstorm-types';
import type { BrainstormService } from './brainstorm-service';

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function asRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

export function createBrainstormTools(
  service: BrainstormService,
  sessionId: string
): AgentRuntimeCustomTool[] {
  const board = () => {
    const detail = service.getBySessionId(sessionId);
    if (!detail) throw new Error('This session has no brainstorm board');
    return detail;
  };

  const setContext: AgentRuntimeCustomTool = {
    name: 'brainstorm_set_context',
    label: 'brainstorm_set_context',
    description:
      'Record a source research actually checked: a connected tool, an uploaded file, or the web. Call this after those lookups, before adding ideas. Set source to the server or file name. Do not record a web-search failure as a source.',
    parameters: Type.Object({
      signals: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            summary: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
            source: Type.Optional(
              Type.String({ description: 'Server or file name. Required for a connected tool.' })
            ),
            kind: Type.Optional(
              Type.String({
                description: 'tool for a connected tool, web for a page, file for an upload.',
              })
            ),
          })
        )
      ),
      phase: Type.Optional(
        Type.String({ description: 'frame, research, diverge, cluster, converge, or wrapup' })
      ),
    }),
    async execute(_toolCallId, params) {
      const input = asRecord(params);
      const detail = service.setContext(board().id, {
        signals: input.signals,
        phase: typeof input.phase === 'string' ? input.phase : undefined,
      });
      if (!detail) return textResult('Brainstorm not found');
      return textResult(`Saved ${detail.signals.length} signal(s). Phase is ${detail.phase}.`);
    },
  };

  const addIdeas: AgentRuntimeCustomTool = {
    name: 'brainstorm_add_ideas',
    label: 'brainstorm_add_ideas',
    description:
      'Add idea cards to the board. Use during Diverge. Each idea needs a title and a short pitch. Include a bold idea and a contrarian idea in the batch. Cite sources when research supports the idea.',
    parameters: Type.Object({
      ideas: Type.Array(
        Type.Object({
          title: Type.String(),
          body: Type.Optional(Type.String({ description: 'One or two sentence pitch.' })),
          rationale: Type.Optional(
            Type.String({ description: 'Why this fits this person and topic.' })
          ),
          tags: Type.Optional(Type.Array(Type.String())),
          impact: Type.Optional(Type.Number({ description: '1-5' })),
          effort: Type.Optional(Type.Number({ description: '1-5' })),
          cluster: Type.Optional(Type.String()),
          sources: Type.Optional(
            Type.Array(Type.Object({ title: Type.String(), url: Type.Optional(Type.String()) }))
          ),
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const ideas = asRecord(params).ideas;
      if (!Array.isArray(ideas) || ideas.length === 0) return textResult('No ideas provided');
      const drafts: BrainstormIdeaDraft[] = ideas.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const rec = entry as Record<string, unknown>;
        const title = typeof rec.title === 'string' ? rec.title : '';
        if (!title.trim()) return [];
        return [
          {
            title,
            body: typeof rec.body === 'string' ? rec.body : '',
            rationale: typeof rec.rationale === 'string' ? rec.rationale : null,
            tags: Array.isArray(rec.tags)
              ? rec.tags.filter((tag): tag is string => typeof tag === 'string')
              : [],
            impact: typeof rec.impact === 'number' ? rec.impact : null,
            effort: typeof rec.effort === 'number' ? rec.effort : null,
            cluster: typeof rec.cluster === 'string' ? rec.cluster : null,
            sources: Array.isArray(rec.sources)
              ? rec.sources.flatMap((source) => {
                  if (!source || typeof source !== 'object') return [];
                  const item = source as Record<string, unknown>;
                  const sourceTitle = typeof item.title === 'string' ? item.title : '';
                  if (!sourceTitle) return [];
                  return [
                    { title: sourceTitle, url: typeof item.url === 'string' ? item.url : null },
                  ];
                })
              : [],
          },
        ];
      });
      const detail = service.addIdeas(board().id, drafts, 'agent');
      if (!detail) return textResult('Brainstorm not found');
      const added = drafts.length;
      return textResult(`Added ${added} idea(s). Board now has ${detail.ideas.length}.`);
    },
  };

  const updateIdea: AgentRuntimeCustomTool = {
    name: 'brainstorm_update_idea',
    label: 'brainstorm_update_idea',
    description: 'Edit one idea card: copy, scores, cluster, star, or discard.',
    parameters: Type.Object({
      id: Type.String(),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      rationale: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      impact: Type.Optional(Type.Number()),
      effort: Type.Optional(Type.Number()),
      cluster: Type.Optional(Type.String()),
      starred: Type.Optional(Type.Boolean()),
      status: Type.Optional(Type.String({ description: 'active or discarded' })),
    }),
    async execute(_toolCallId, params) {
      const input = asRecord(params);
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) return textResult('Idea id is required');
      const detail = service.updateIdea(
        id,
        {
          title: typeof input.title === 'string' ? input.title : undefined,
          body: typeof input.body === 'string' ? input.body : undefined,
          rationale: typeof input.rationale === 'string' ? input.rationale : undefined,
          tags: Array.isArray(input.tags)
            ? input.tags.filter((tag): tag is string => typeof tag === 'string')
            : undefined,
          impact: typeof input.impact === 'number' ? input.impact : undefined,
          effort: typeof input.effort === 'number' ? input.effort : undefined,
          cluster: typeof input.cluster === 'string' ? input.cluster : undefined,
          starred: typeof input.starred === 'boolean' ? input.starred : undefined,
          status:
            input.status === 'discarded' || input.status === 'active' ? input.status : undefined,
        },
        'agent'
      );
      if (!detail) return textResult(`Idea not found: ${id}`);
      return textResult(`Updated idea ${id}.`);
    },
  };

  const cluster: AgentRuntimeCustomTool = {
    name: 'brainstorm_cluster',
    label: 'brainstorm_cluster',
    description: 'Group existing ideas into named clusters. Pass idea ids from the board snapshot.',
    parameters: Type.Object({
      clusters: Type.Array(
        Type.Object({
          name: Type.String(),
          ideaIds: Type.Array(Type.String()),
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const groups = asRecord(params).clusters;
      if (!Array.isArray(groups)) return textResult('No clusters provided');
      const detail = service.cluster(
        board().id,
        groups.map((group) => {
          const rec = (group || {}) as Record<string, unknown>;
          return {
            name: typeof rec.name === 'string' ? rec.name : '',
            ideaIds: Array.isArray(rec.ideaIds)
              ? rec.ideaIds.filter((id): id is string => typeof id === 'string')
              : [],
          };
        })
      );
      if (!detail) return textResult('Brainstorm not found');
      return textResult(`Clustered ideas on "${detail.topic}".`);
    },
  };

  const setPhase: AgentRuntimeCustomTool = {
    name: 'brainstorm_set_phase',
    label: 'brainstorm_set_phase',
    description: 'Move the session to frame, research, diverge, cluster, converge, or wrapup.',
    parameters: Type.Object({
      phase: Type.String(),
    }),
    async execute(_toolCallId, params) {
      const phase = String(asRecord(params).phase || '');
      const detail = service.setPhase(board().id, phase);
      if (!detail) return textResult('Brainstorm not found');
      return textResult(`Phase is now ${detail.phase}.`);
    },
  };

  const saveBrief: AgentRuntimeCustomTool = {
    name: 'brainstorm_save_brief',
    label: 'brainstorm_save_brief',
    description:
      'Save the wrap-up brief: summary, ranked idea ids (best first), first experiments, open questions, and sources. Moves the session to wrap-up.',
    parameters: Type.Object({
      summary: Type.String(),
      rankedIdeaIds: Type.Optional(Type.Array(Type.String())),
      experiments: Type.Optional(
        Type.Array(
          Type.Object({
            ideaId: Type.Optional(Type.String()),
            title: Type.String(),
            steps: Type.String(),
          })
        )
      ),
      openQuestions: Type.Optional(Type.Array(Type.String())),
      sources: Type.Optional(
        Type.Array(Type.Object({ title: Type.String(), url: Type.Optional(Type.String()) }))
      ),
    }),
    async execute(_toolCallId, params) {
      const detail = service.saveBrief(board().id, asRecord(params));
      if (!detail?.brief) return textResult('Could not save the brief');
      return textResult(
        `Brief saved. ${detail.brief.rankedIdeaIds.length} ranked idea(s), ${detail.brief.experiments.length} experiment(s).`
      );
    },
  };

  return [setContext, addIdeas, updateIdea, cluster, setPhase, saveBrief];
}
