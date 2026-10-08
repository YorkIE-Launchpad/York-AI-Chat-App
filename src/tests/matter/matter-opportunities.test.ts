import { describe, expect, it, vi } from 'vitest';

vi.mock('../../main/agent/sdk-one-shot', () => ({ runPiAiOneShot: vi.fn() }));
vi.mock('../../main/jev/jev-client', () => ({ isJevEnabled: () => false }));
vi.mock('../../main/jev/matter-jev', () => ({ runMatterJevDecisions: vi.fn() }));

import { normalizeMatterOpportunitiesConfig } from '../../main/matter/matter-config';
import {
  buildOpportunityReport,
  parseOpportunityResponse,
  type OpportunityContext,
} from '../../main/matter/matter-opportunities';
import { opportunityDestination, type MatterOpportunity } from '../../shared/matter';

const context: OpportunityContext = {
  clientRoster: null,
  items: [
    {
      ref: 'slack:msg:C1:1.0',
      source: 'slack',
      title: 'Asha in #acme',
      text: 'Acme says their pipeline dropped 30% and they need outbound help.',
      sourceRef: { label: 'Slack', url: 'https://slack.example/p1' },
    },
    {
      ref: 'meeting:m1',
      source: 'meeting',
      title: 'Internal sync',
      text: 'Hub timesheet page crashes on submit.',
      sourceRef: { label: 'Internal sync' },
    },
  ],
};

describe('parseOpportunityResponse', () => {
  it('keeps valid opportunities and anchors them to the cited source', () => {
    const drafts = parseOpportunityResponse(
      {
        opportunities: [
          {
            ref: 'slack:msg:C1:1.0',
            kind: 'cross_sell',
            target: 'gtm_services',
            title: 'Acme needs outbound help',
            summary: 'Pipeline down 30%.',
            evidence: 'pipeline dropped 30%',
            clientName: 'Acme',
            suggestedPitch: 'Offer a GTM pod.',
            confidence: 0.8,
          },
          {
            ref: 'meeting:m1',
            kind: 'platform_issue',
            target: 'hub',
            title: 'Hub timesheet submit crash',
            clientName: 'Should be dropped',
            confidence: 1.7,
          },
        ],
      },
      context
    );
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      kind: 'cross_sell',
      target: 'gtm_services',
      source: 'slack',
      clientName: 'Acme',
      sourceRef: { url: 'https://slack.example/p1' },
    });
    expect(drafts[1]).toMatchObject({
      kind: 'platform_issue',
      clientName: null,
      suggestedPitch: null,
      confidence: 1,
    });
    expect(drafts[1].evidence).toContain('crashes on submit');
  });

  it('drops unknown refs, invalid targets, and kind/target mismatches', () => {
    const drafts = parseOpportunityResponse(
      {
        opportunities: [
          { ref: 'nope', kind: 'upsell', target: 'finops', title: 'x' },
          { ref: 'meeting:m1', kind: 'upsell', target: 'made_up', title: 'x' },
          { ref: 'meeting:m1', kind: 'platform_issue', target: 'finops', title: 'x' },
          { ref: 'slack:msg:C1:1.0', kind: 'upsell', target: 'hub', title: 'x' },
        ],
      },
      context
    );
    expect(drafts).toEqual([]);
  });

  it('tolerates malformed payloads', () => {
    expect(parseOpportunityResponse(null, context)).toEqual([]);
    expect(parseOpportunityResponse({ opportunities: 'x' }, context)).toEqual([]);
  });
});

describe('opportunity config and routing', () => {
  it('fills defaults and keeps only known routing targets', () => {
    const config = normalizeMatterOpportunitiesConfig({
      routing: { hub: { slackChannel: '  #hub-bugs ' }, bogus: { slackChannel: '#x' } },
    });
    expect(config.enabled).toBe(true);
    expect(config.notify).toBe(true);
    expect(config.minConfidence).toBe(0.6);
    expect(config.routing.hub).toEqual({ slackChannel: '#hub-bugs' });
    expect(config.routing.finops).toEqual({});
    expect('bogus' in config.routing).toBe(false);
  });

  it('prefers the channel over a user for the destination', () => {
    const { routing } = normalizeMatterOpportunitiesConfig({
      routing: {
        hub: { slackChannel: '#hub-bugs', slackUserId: 'U1' },
        finops: { slackUserId: 'U2' },
      },
    });
    expect(opportunityDestination(routing, 'hub')).toBe('#hub-bugs');
    expect(opportunityDestination(routing, 'finops')).toBe('U2');
    expect(opportunityDestination(routing, 'marketing')).toBeNull();
  });
});

describe('buildOpportunityReport', () => {
  it('includes kind, target, client, evidence, link, and reporter', () => {
    const opp: MatterOpportunity = {
      id: 'o1',
      fingerprint: 'opp:upsell:rnd_services:abc',
      kind: 'upsell',
      target: 'rnd_services',
      title: 'Acme wants phase 2',
      summary: 'Acme asked about extending the build.',
      evidence: 'can we extend the team for phase 2?',
      source: 'gmail',
      sourceRef: { label: 'Gmail', url: 'https://mail.example/1' },
      clientName: 'Acme',
      suggestedPitch: 'Propose a phase-2 pod.',
      confidence: 0.9,
      status: 'new',
      snoozeUntil: null,
      reportedAt: null,
      reportedTo: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const text = buildOpportunityReport(opp, 'Kalrav');
    expect(text).toContain('Upsell opportunity — R&D / Software Development');
    expect(text).toContain('Client: Acme');
    expect(text).toContain('> can we extend the team for phase 2?');
    expect(text).toContain('<https://mail.example/1|Gmail>');
    expect(text).toContain('Suggested opener: Propose a phase-2 pod.');
    expect(text).toContain('Reported by Kalrav via Matter');
  });
});
