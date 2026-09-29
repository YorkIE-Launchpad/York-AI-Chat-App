import { describe, expect, it, vi } from 'vitest';
import { researchLoop } from '../../main/loops/loop-research';
import type { MeetingService } from '../../main/meetings/meeting-service';
import type { ChatSearchHit } from '../../shared/chat-search';
import type { Loop } from '../../shared/loops';

const DAY = 864e5;
const now = Date.now();

function makeLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1',
    fingerprint: 'meeting:action:m1:abc',
    title: 'Send Acme renewal pricing to Priya',
    notes: null,
    researchNote: null,
    researchSources: [],
    researchStatus: 'running',
    researchError: null,
    researchedAt: null,
    origin: 'meeting',
    sourceRef: { meetingId: 'm1', label: 'Acme sync' },
    owner: 'me',
    counterpart: 'Priya',
    dueAt: null,
    priority: 'normal',
    status: 'open',
    autoCaptured: true,
    createdAt: 0,
    updatedAt: 0,
    closedAt: null,
    ...overrides,
  };
}

const meetings: Record<string, { id: string; title: string; startedAt: number; notes: unknown }> = {
  m1: {
    id: 'm1',
    title: 'Acme sync',
    startedAt: now - 2 * DAY,
    notes: {
      title: 'Acme sync',
      summary: 'Acme wants renewal pricing before Friday.',
      actionItems: ['Send Acme renewal pricing to Priya'],
    },
  },
  m2: {
    id: 'm2',
    title: 'Acme pricing review',
    startedAt: now - 10 * DAY,
    notes: {
      title: 'Acme pricing review',
      summary: 'Agreed Acme renewal at 8% uplift.',
      actionItems: [],
    },
  },
  old: {
    id: 'old',
    title: 'Acme kickoff',
    startedAt: now - 120 * DAY,
    notes: { title: 'Acme kickoff', summary: 'Initial scope.', actionItems: [] },
  },
};

const meetingService = {
  search: vi.fn(() =>
    ['m1', 'm2', 'old'].map((id) => ({
      id,
      title: meetings[id].title,
      startedAt: meetings[id].startedAt,
      summary: null,
    }))
  ),
  get: (id: string) => meetings[id] ?? null,
} as unknown as MeetingService;

const chatHit: ChatSearchHit = {
  sessionId: 's1',
  messageId: 'msg1',
  title: 'Acme renewal draft',
  snippet: 'Draft email to Priya with the 8% uplift numbers.',
  timestamp: now - DAY,
  pinned: false,
} as ChatSearchHit;

describe('researchLoop', () => {
  it('uses origin, recent chats and recent meetings, keeping only cited sources', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        relevant: true,
        note: '**Where it stands**\n- Pricing owed before Friday [E1]\n- Draft ready [E2]',
      }),
    });
    const searchChats = vi.fn(() => [chatHit]);
    const result = await researchLoop(makeLoop(), {
      mcp: null,
      meetingService,
      matterItem: null,
      searchChats,
      llm: { complete, embed: vi.fn() },
    });

    expect(searchChats).toHaveBeenCalled();
    const prompt = JSON.parse(complete.mock.calls[0][0].userPrompt) as {
      evidence: Array<{ id: string; title: string }>;
    };
    expect(prompt.evidence.map((e) => e.title)).toEqual([
      'Meeting: Acme sync',
      'Chat: Acme renewal draft',
      'Meeting: Acme pricing review',
    ]);
    expect(result.sources.map((s) => s.title)).toEqual([
      'Meeting: Acme sync',
      'Chat: Acme renewal draft',
    ]);
  });

  it('returns an empty note without calling the LLM when nothing is found', async () => {
    const complete = vi.fn();
    const result = await researchLoop(
      makeLoop({ sourceRef: {}, title: 'Book dentist', counterpart: null }),
      {
        mcp: null,
        meetingService: null,
        matterItem: null,
        searchChats: () => [],
        llm: { complete, embed: vi.fn() },
      }
    );
    expect(result).toEqual({ note: '', sources: [] });
    expect(complete).not.toHaveBeenCalled();
  });

  it('accepts fenced JSON and plain markdown replies', async () => {
    const fenced = vi.fn().mockResolvedValue({
      text: '```json\n{"relevant":true,"note":"- Owed Friday [E1]"}\n```',
    });
    const a = await researchLoop(makeLoop(), {
      mcp: null,
      meetingService,
      matterItem: null,
      llm: { complete: fenced, embed: vi.fn() },
    });
    expect(a.note).toBe('- Owed Friday [E1]');

    const plain = vi.fn().mockResolvedValue({ text: '**Where it stands**\n- Owed Friday [E1]' });
    const b = await researchLoop(makeLoop(), {
      mcp: null,
      meetingService,
      matterItem: null,
      llm: { complete: plain, embed: vi.fn() },
    });
    expect(b.sources.map((s) => s.id)).toEqual(['E1']);
  });

  it('returns a stated deadline only when it is backed by real evidence', async () => {
    const backed = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        relevant: true,
        note: '- Owed Friday [E1]',
        deadline: '2026-10-02',
        deadlineEvidence: 'E1',
      }),
    });
    const a = await researchLoop(makeLoop(), {
      mcp: null,
      meetingService,
      matterItem: null,
      llm: { complete: backed, embed: vi.fn() },
    });
    expect(a.dueAt).toBe(new Date(2026, 9, 2, 17, 0, 0, 0).getTime());

    const unbacked = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        relevant: true,
        note: '- Owed Friday [E1]',
        deadline: '2026-10-02',
        deadlineEvidence: 'E99',
      }),
    });
    const b = await researchLoop(makeLoop(), {
      mcp: null,
      meetingService,
      matterItem: null,
      llm: { complete: unbacked, embed: vi.fn() },
    });
    expect(b.dueAt).toBeUndefined();
  });

  it('returns an empty note when the model reports nothing relevant', async () => {
    const complete = vi.fn().mockResolvedValue({ text: '{"relevant":false,"note":""}' });
    const result = await researchLoop(makeLoop(), {
      mcp: null,
      meetingService,
      matterItem: null,
      llm: { complete, embed: vi.fn() },
    });
    expect(result).toEqual({ note: '', sources: [] });
  });
});
