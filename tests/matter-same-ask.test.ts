import { describe, expect, it } from 'vitest';
import {
  applySameAskGroups,
  collapseSameAskItems,
  omitSameAskAs,
} from '../src/main/matter/matter-same-ask';

describe('collapseSameAskItems', () => {
  it('collapses paraphrases of one ask and keeps the highest rank', () => {
    const collapsed = collapseSameAskItems([
      {
        fingerprint: 'slack:1',
        source: 'slack',
        title: 'Please review the Q3 deck before Friday',
        summary: 'Q3 deck review needed by Friday',
        rankScore: 40,
      },
      {
        fingerprint: 'gmail:1',
        source: 'gmail',
        title: 'Q3 deck needs your review by Friday',
        summary: 'Please review the Q3 deck before Friday',
        rankScore: 55,
      },
      {
        fingerprint: 'jira:1',
        source: 'jira',
        title: 'Review the Q3 deck approval needed Friday',
        summary: 'Q3 deck review before Friday',
        rankScore: 70,
      },
    ]);
    expect(collapsed.map((item) => item.fingerprint)).toEqual(['jira:1']);
  });

  it('keeps two unrelated Slack DMs', () => {
    const collapsed = collapseSameAskItems([
      {
        fingerprint: 'slack:dm',
        source: 'slack',
        title: 'Ada in DM: looping you in on the deck',
        summary: 'looping you in on the deck',
        rankScore: 20,
      },
      {
        fingerprint: 'slack:channel',
        source: 'slack',
        title: 'Sam in #eng: standup notes from this morning',
        summary: 'standup notes from this morning',
        rankScore: 20,
      },
    ]);
    expect(collapsed.map((item) => item.fingerprint).sort()).toEqual(['slack:channel', 'slack:dm']);
  });

  it('prefers Jira over Slack when rank scores tie', () => {
    const collapsed = collapseSameAskItems([
      {
        fingerprint: 'slack:1',
        source: 'slack',
        title: 'Review the Q3 deck before Friday',
        summary: 'Q3 deck review Friday',
        rankScore: 50,
      },
      {
        fingerprint: 'jira:1',
        source: 'jira',
        title: 'Review the Q3 deck before Friday',
        summary: 'Q3 deck review Friday',
        rankScore: 50,
      },
    ]);
    expect(collapsed.map((item) => item.fingerprint)).toEqual(['jira:1']);
  });
});

describe('omitSameAskAs', () => {
  it('drops a new fingerprint that paraphrases a dismissed ask', () => {
    const kept = omitSameAskAs(
      [
        {
          fingerprint: 'gmail:new',
          title: 'Q3 deck needs your review by Friday',
          summary: 'Please review the Q3 deck before Friday',
        },
        {
          fingerprint: 'slack:other',
          title: 'Standup notes from this morning',
          summary: 'standup notes from this morning',
        },
      ],
      [
        {
          title: 'Please review the Q3 deck before Friday',
          summary: 'Q3 deck review needed by Friday',
        },
      ]
    );
    expect(kept.map((item) => item.fingerprint)).toEqual(['slack:other']);
  });
});

describe('applySameAskGroups', () => {
  it('keeps the Jira fingerprint and records the other sources', () => {
    const applied = applySameAskGroups(
      [
        { fingerprint: 'slack:1', source: 'slack' },
        { fingerprint: 'gmail:1', source: 'gmail' },
        { fingerprint: 'jira:1', source: 'jira' },
        { fingerprint: 'slack:2', source: 'slack' },
      ],
      [['slack:1', 'gmail:1', 'jira:1']]
    );
    expect(applied.kept.map((item) => item.fingerprint)).toEqual(['jira:1', 'slack:2']);
    expect(applied.alsoSeenIn.get('jira:1')?.sort()).toEqual(['gmail', 'slack']);
  });
});
