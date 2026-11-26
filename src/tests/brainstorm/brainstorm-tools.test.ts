import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureBrainstormSchema } from '../../main/brainstorm/brainstorm-schema';
import { BrainstormService } from '../../main/brainstorm/brainstorm-service';
import { BrainstormStore } from '../../main/brainstorm/brainstorm-store';
import { createBrainstormTools } from '../../main/brainstorm/brainstorm-tools';
import type { DatabaseInstance } from '../../main/db/database';
import type { BrainstormDetail } from '../../shared/brainstorm-types';

function harness() {
  const sqlite = new Database(':memory:');
  ensureBrainstormSchema(sqlite);
  const store = new BrainstormStore({ raw: sqlite } as DatabaseInstance);
  const emitted: BrainstormDetail[] = [];
  const service = new BrainstormService(
    store,
    {
      resolveProfile: async () => null,
      createIdleSession: async () => {
        throw new Error('not used');
      },
      continueSession: async () => undefined,
      deleteSession: async () => undefined,
      broadcastSessions: () => undefined,
      writeBriefFile: () => '/tmp/brief.html',
    },
    (detail) => emitted.push(detail),
    () => undefined
  );
  const created = store.create({
    sessionId: 'session-9',
    topic: 'Pricing page',
    goal: null,
    technique: 'hmw',
    profile: {
      name: 'Sam',
      email: 'sam@example.com',
      title: 'Product Manager',
      functionName: null,
      squad: null,
      department: 'Product',
      roleNote: null,
    },
  });
  return { service, created, emitted };
}

async function run(
  tool: ReturnType<typeof createBrainstormTools>[number],
  params: Record<string, unknown>
): Promise<string> {
  const result = await (
    tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>
  )('1', params);
  return result.content[0]?.text || '';
}

describe('brainstorm tools', () => {
  it('records signals, ideas, a cluster, and a brief on the session board', async () => {
    const { service, created, emitted } = harness();
    const tools = createBrainstormTools(service, 'session-9');
    expect(tools.map((tool) => tool.name)).toEqual([
      'brainstorm_set_context',
      'brainstorm_add_ideas',
      'brainstorm_update_idea',
      'brainstorm_cluster',
      'brainstorm_set_phase',
      'brainstorm_save_brief',
    ]);

    const context = await run(tools[0], {
      phase: 'research',
      signals: [
        {
          title: 'Competitors dropped setup fees',
          summary: 'Three of them this quarter.',
          url: 'https://news.example',
        },
      ],
    });
    expect(context).toContain('1 signal');
    expect(context).toContain('research');

    const added = await run(tools[1], {
      ideas: [
        {
          title: 'Price the outcome',
          body: 'Quote time-to-value, not seats.',
          impact: 4,
          effort: 3,
        },
        { title: 'Publish the price', body: 'Stop hiding it.', tags: ['contrarian'] },
      ],
    });
    expect(added).toContain('Added 2');

    const detail = service.get(created.id)!;
    const phase = await run(tools[4], { phase: 'diverge' });
    expect(phase).toContain('diverge');

    const grouped = await run(tools[3], {
      clusters: [{ name: 'Offer', ideaIds: detail.ideas.map((idea) => idea.id) }],
    });
    expect(grouped).toContain('Pricing page');

    const updated = await run(tools[2], { id: detail.ideas[0].id, starred: true });
    expect(updated).toContain(detail.ideas[0].id);

    const saved = await run(tools[5], {
      summary: 'Lead with transparent pricing.',
      rankedIdeaIds: [detail.ideas[1].id, detail.ideas[0].id],
      experiments: [{ title: 'Show price on the page', steps: 'One segment, two weeks.' }],
      openQuestions: ['Which segment?'],
      sources: [{ title: 'News', url: 'https://news.example' }],
    });
    expect(saved).toContain('Brief saved');

    const final = service.get(created.id)!;
    expect(final.status).toBe('wrapped');
    expect(final.signals).toHaveLength(1);
    expect(final.ideas.every((idea) => idea.cluster === 'Offer')).toBe(true);
    expect(final.ideas.some((idea) => idea.starred)).toBe(true);
    expect(final.brief?.summary).toContain('transparent pricing');
    expect(emitted.length).toBeGreaterThan(0);
    expect(service.exportBrief(created.id).html).toContain('Pricing page');
  });
});
