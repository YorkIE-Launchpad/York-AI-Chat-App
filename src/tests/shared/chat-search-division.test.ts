import { describe, expect, it } from 'vitest';
import {
  filterChatSearchHitsByDivision,
  type ChatSearchHit,
} from '../../shared/chat-search';

const baseHit = (overrides: Partial<ChatSearchHit>): ChatSearchHit => ({
  sessionId: 's1',
  messageId: null,
  title: 'Chat',
  snippet: 'hello',
  timestamp: 1,
  pinned: false,
  division: 'general',
  hubProjectId: null,
  hubProjectName: null,
  launchpadProjectId: null,
  launchpadProjectName: null,
  folderId: null,
  folderName: null,
  projectCanonicalKey: null,
  clientName: null,
  clientProjectIds: null,
  ...overrides,
});

describe('filterChatSearchHitsByDivision', () => {
  it('returns all hits when scope is all', () => {
    const hits = [
      baseHit({ sessionId: 'a', division: 'general' }),
      baseHit({ sessionId: 'b', division: 'hub' }),
    ];
    expect(
      filterChatSearchHitsByDivision(hits, { kind: 'project', canonicalKey: 'hub:x', name: 'X', sources: { hub: true } }, 'all')
    ).toHaveLength(2);
  });

  it('filters to active project workspace', () => {
    const hits = [
      baseHit({
        sessionId: 'a',
        division: 'project',
        hubProjectId: 'alpha',
        projectCanonicalKey: 'hub:alpha',
      }),
      baseHit({ sessionId: 'b', division: 'general' }),
    ];
    const filtered = filterChatSearchHitsByDivision(
      hits,
      {
        kind: 'project',
        canonicalKey: 'hub:alpha',
        name: 'Alpha',
        hubProjectId: 'alpha',
        sources: { hub: true },
      },
      'workspace'
    );
    expect(filtered.map((h) => h.sessionId)).toEqual(['a']);
  });
});
