import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ensureBrainstormSchema } from '../../main/brainstorm/brainstorm-schema';
import { publishBrainstorm, readSharedBrainstorm } from '../../main/brainstorm/brainstorm-collab';
import { BrainstormService } from '../../main/brainstorm/brainstorm-service';
import { BrainstormStore } from '../../main/brainstorm/brainstorm-store';
import type { DatabaseInstance } from '../../main/db/database';
import { emptyProfileSnapshot } from '../../shared/brainstorm-types';
import { persistModelPick } from '../../renderer/components/model-selection-target';
import { peopleFromDirectoryBody } from '../../main/brainstorm/brainstorm-people';

function openStore(): BrainstormStore {
  const sqlite = new Database(':memory:');
  ensureBrainstormSchema(sqlite);
  return new BrainstormStore({ raw: sqlite } as DatabaseInstance);
}

describe('brainstorm activity', () => {
  it('records who added an idea, a thought, and a star', () => {
    const store = openStore();
    store.setActor({ email: 'a@york.ie', name: 'Ada' });
    const created = store.create({
      sessionId: 's1',
      topic: 'Pricing',
      goal: null,
      technique: 'auto',
      profile: emptyProfileSnapshot(),
    });
    const withIdea = store.addIdeas(created.id, [{ title: 'Usage tiers' }], 'user');
    store.addThought(created.id, withIdea!.ideas[0].id, 'Try annual first');
    store.updateIdea(withIdea!.ideas[0].id, { starred: true });
    const activity = store.get(created.id)?.activity || [];
    expect(activity.map((row) => row.kind).sort()).toEqual(['idea_added', 'starred', 'thought']);
    expect(withIdea?.ideas[0].authorName).toBe('Ada');
    expect(activity.find((row) => row.kind === 'thought')?.text).toBe('Try annual first');
  });
});

describe('brainstorm collab bridge', () => {
  it('applies a remote idea twice without duplicating it', () => {
    const owner = openStore();
    const created = owner.create({
      sessionId: 'owner-session',
      topic: 'Shared',
      goal: null,
      technique: 'auto',
      profile: emptyProfileSnapshot(),
    });
    owner.addIdeas(created.id, [{ title: 'One idea' }], 'agent');
    const detail = owner.get(created.id)!;
    const doc = new Y.Doc();
    publishBrainstorm(doc, detail);
    publishBrainstorm(doc, detail);
    const shared = readSharedBrainstorm(doc);
    expect(shared.ideas).toHaveLength(1);

    const peer = openStore();
    const joined = peer.create({
      sessionId: 'peer-session',
      topic: 'Shared brainstorm',
      goal: null,
      technique: 'auto',
      profile: emptyProfileSnapshot(),
    });
    const remote = {
      ...joined,
      ideas: detail.ideas,
      activity: detail.activity,
      signals: detail.signals,
    };
    peer.applyRemote(remote);
    peer.applyRemote(remote);
    expect(peer.get(joined.id)?.ideas).toHaveLength(1);
    expect(peer.get(joined.id)?.ideas[0].title).toBe('One idea');
  });
});

describe('brainstorm file sources', () => {
  it('indexes files before the kickoff and lists them on the board', async () => {
    const sqlite = new Database(':memory:');
    ensureBrainstormSchema(sqlite);
    const store = new BrainstormStore({ raw: sqlite } as DatabaseInstance);
    const order: string[] = [];
    const service = new BrainstormService(
      store,
      {
        resolveProfile: async () => null,
        createIdleSession: async () =>
          ({
            id: 'session-files',
            title: 'Files',
            status: 'idle',
            messages: [],
            createdAt: 1,
            updatedAt: 1,
          }) as never,
        continueSession: async () => {
          order.push('kickoff');
        },
        deleteSession: async () => undefined,
        broadcastSessions: () => undefined,
        writeBriefFile: () => '/tmp/brief.html',
        addKnowledgeFiles: async () => {
          order.push('files');
          return [{ id: 'src-1', title: 'plan.pdf', status: 'ready' }];
        },
        readKnowledge: () => 'Revenue was 12.',
        getCollabDoc: () => null,
      },
      () => undefined,
      () => undefined
    );
    const { detail } = await service.create({
      topic: 'Pricing',
      filePaths: ['/tmp/plan.pdf'],
    });
    expect(order).toEqual(['files', 'kickoff']);
    expect(
      detail.signals.some((signal) => signal.kind === 'file' && signal.title === 'plan.pdf')
    ).toBe(true);
    expect(detail.activity?.some((row) => row.kind === 'file_added')).toBe(true);
  });
});

describe('hub people search', () => {
  it('reads directory rows into name, title, and email', () => {
    const people = peopleFromDirectoryBody({
      data: [
        {
          email: 'Ada@york.ie',
          first_name: 'Ada',
          last_name: 'Lovelace',
          designation: { name: 'Engineer' },
          profile_pic: 'https://example.com/a.png',
        },
      ],
    });
    expect(people).toEqual([
      {
        email: 'ada@york.ie',
        name: 'Ada Lovelace',
        title: 'Engineer',
        image: 'https://example.com/a.png',
      },
    ]);
  });
});

describe('model pick destination', () => {
  it('locks a brainstorm session instead of the global config', () => {
    expect(
      persistModelPick({
        sessionId: 's1',
        brainstormId: 'b1',
        model: 'claude',
        provider: 'anthropic',
      })
    ).toEqual({
      type: 'brainstorm.setModel',
      payload: { id: 'b1', model: 'claude', provider: 'anthropic' },
    });
    expect(persistModelPick({ model: 'claude', provider: 'anthropic' })).toEqual({
      type: 'config',
    });
    expect(
      persistModelPick({ sessionId: 's1', brainstormId: 'b1', model: 'auto' }).payload
    ).toMatchObject({ model: 'auto', provider: 'anthropic' });
  });
});
