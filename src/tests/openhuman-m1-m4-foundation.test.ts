import { describe, expect, it } from 'vitest';
import { compileMatterItemToWikiPage } from '../main/wiki/wiki-compiler';
import { isBriefLikeIntent } from '../shared/supercontext';
import { topologicalOrder, createEmptyWorkflowGraph } from '../shared/workflows';
import type { MatterItem } from '../shared/matter';

function sampleMatterItem(overrides: Partial<MatterItem> = {}): MatterItem {
  return {
    id: 'm1',
    fingerprint: 'fp1',
    title: 'Acme renewal risk',
    summary: 'Contract at risk',
    whyItMatters: 'Revenue',
    rawDetails: 'Email excerpt',
    severity: 'warning',
    orbit: 'today',
    category: 'client',
    source: 'gmail',
    sourceRef: {},
    confidence: 0.8,
    suggestedAction: 'Follow up',
    status: 'active',
    pinned: false,
    snoozeUntil: null,
    dueAt: null,
    remindAt: null,
    expiresAt: null,
    reminderNotifiedAt: null,
    expiredNotifiedAt: null,
    rankScore: 72,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    resolvedAt: null,
    ...overrides,
  };
}

describe('M1 wiki compiler', () => {
  it('maps client Matter items into clients/ wiki paths', () => {
    const page = compileMatterItemToWikiPage(sampleMatterItem());
    expect(page.path.startsWith('clients/')).toBe(true);
    expect(page.title).toContain('Acme');
    expect(page.sources?.[0]?.kind).toBe('matter');
  });
});

describe('M2 supercontext intents', () => {
  it('detects brief-like prompts', () => {
    expect(isBriefLikeIntent('catch me up on Acme')).toBe(true);
    expect(isBriefLikeIntent('what is 2+2')).toBe(false);
  });
});

describe('M4 workflow topology', () => {
  it('orders linear graphs', () => {
    const graph = createEmptyWorkflowGraph();
    graph.nodes.push({
      id: 'agent_1',
      type: 'agent',
      label: 'A',
      prompt: 'do things',
    });
    graph.edges.push({ id: 'e1', from: 'trigger_1', to: 'agent_1' });
    expect(topologicalOrder(graph)).toEqual(['trigger_1', 'agent_1']);
  });
});
