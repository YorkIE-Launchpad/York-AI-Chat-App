import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureBrainstormSchema } from '../../main/brainstorm/brainstorm-schema';
import { BrainstormStore } from '../../main/brainstorm/brainstorm-store';
import type { DatabaseInstance } from '../../main/db/database';
import { emptyProfileSnapshot } from '../../shared/brainstorm-types';

function openStore(): BrainstormStore {
  const sqlite = new Database(':memory:');
  ensureBrainstormSchema(sqlite);
  return new BrainstormStore({ raw: sqlite } as DatabaseInstance);
}

describe('brainstorm store', () => {
  it('creates a board, adds ideas, clusters them, and saves a brief', () => {
    const store = openStore();
    const created = store.create({
      sessionId: 'session-1',
      topic: 'Pipeline velocity',
      goal: 'Q1',
      technique: 'auto',
      profile: { ...emptyProfileSnapshot(), title: 'RevOps Manager', department: 'Revenue' },
    });
    expect(created.phase).toBe('frame');
    expect(created.ideas).toEqual([]);

    const withIdeas = store.addIdeas(
      created.id,
      [
        {
          title: 'Stage aging alerts',
          body: 'Ping owners when a stage sits.',
          impact: 5,
          effort: 2,
        },
        {
          title: 'Kill the weekly forecast meeting',
          body: 'Replace it with a written exception list.',
          tags: ['contrarian'],
        },
      ],
      'agent'
    );
    expect(withIdeas?.ideas).toHaveLength(2);

    const starred = store.updateIdea(withIdeas!.ideas[0].id, { starred: true, impact: 9 });
    expect(starred?.ideas[0].starred).toBe(true);
    expect(starred?.ideas[0].impact).toBe(5);

    const clustered = store.cluster(created.id, [
      { name: 'Process', ideaIds: withIdeas!.ideas.map((idea) => idea.id) },
    ]);
    expect(clustered?.ideas.every((idea) => idea.cluster === 'Process')).toBe(true);

    const wrapped = store.saveBrief(created.id, {
      summary: 'Start with stage aging.',
      rankedIdeaIds: [withIdeas!.ideas[0].id],
      experiments: [{ title: 'Pilot alerts', steps: 'One team, two weeks.' }],
      openQuestions: ['Which stages?'],
      sources: [{ title: 'Example', url: 'https://example.com' }],
    });
    expect(wrapped?.status).toBe('wrapped');
    expect(wrapped?.phase).toBe('wrapup');
    expect(wrapped?.brief?.experiments[0].title).toBe('Pilot alerts');

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].starredCount).toBe(1);
    expect(listed[0].topIdeaTitles[0]).toBe('Stage aging alerts');
    expect(store.getBySessionId('session-1')?.id).toBe(created.id);

    expect(store.remove(created.id)).toBe(true);
    expect(store.get(created.id)).toBeNull();
  });

  it('keeps a user-added idea distinct from agent ideas', () => {
    const store = openStore();
    const created = store.create({
      sessionId: 'session-2',
      topic: 'Onboarding',
      goal: null,
      technique: 'jtbd',
      profile: emptyProfileSnapshot(),
    });
    const next = store.addIdeas(created.id, [{ title: 'Buddy in week one', body: 'Mine' }], 'user');
    expect(next?.ideas[0].author).toBe('user');
    expect(store.removeBySessionId('session-2')).toBe(created.id);
    expect(store.list()).toEqual([]);
  });
});
