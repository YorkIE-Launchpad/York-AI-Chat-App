import { describe, expect, it } from 'vitest';
import {
  buildBrainstormPlaybook,
  formatConnectedToolSources,
  roleLensFor,
} from '../../main/brainstorm/brainstorm-prompt';
import {
  emptyProfileSnapshot,
  parseBrainstormCommand,
  type BrainstormDetail,
} from '../../shared/brainstorm-types';
import { renderBrainstormBriefHtml } from '../../shared/brainstorm-brief-html';

function detail(partial: Partial<BrainstormDetail> = {}): BrainstormDetail {
  return {
    id: 'b1',
    sessionId: 's1',
    topic: 'New onboarding motion',
    goal: 'Cut time to first value',
    technique: 'jtbd',
    profileSnapshot: {
      ...emptyProfileSnapshot(),
      name: 'Ava',
      title: 'Senior Product Manager',
      department: 'Product',
    },
    signals: [],
    phase: 'frame',
    status: 'active',
    brief: null,
    createdAt: 1,
    updatedAt: 1,
    ideas: [],
    ...partial,
  };
}

describe('brainstorm prompt', () => {
  it('picks a role lens from title and department', () => {
    expect(roleLensFor({ ...emptyProfileSnapshot(), title: 'RevOps Manager' }).id).toBe('revops');
    expect(roleLensFor({ ...emptyProfileSnapshot(), title: 'Senior Product Manager' }).id).toBe(
      'product'
    );
    expect(roleLensFor({ ...emptyProfileSnapshot(), department: 'People' }).id).toBe('people');
    expect(roleLensFor({ ...emptyProfileSnapshot(), title: 'Teacher' }).id).toBe('general');
  });

  it('puts the board, including user edits, into the playbook', () => {
    const text = buildBrainstormPlaybook(
      detail({
        ideas: [
          {
            id: 'idea-1',
            brainstormId: 'b1',
            cluster: null,
            title: 'Skip the kickoff deck',
            body: 'Send a one-page brief instead.',
            rationale: null,
            tags: [],
            impact: 4,
            effort: 1,
            starred: true,
            status: 'active',
            sources: [],
            author: 'user',
            position: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })
    );
    expect(text).toContain('Senior Product Manager');
    expect(text).toContain('Jobs to be done');
    expect(text).toContain('websearch');
    expect(text).toContain('Slack');
    expect(text).toContain('Gmail');
    expect(text).toContain('Google Drive');
    expect(text).toContain('connected tool');
    expect(text).toContain('none are connected');
    expect(text).toContain('Skip the kickoff deck');
    expect(text).toContain('added by user');
    expect(text).toContain('starred');
    expect(text).toContain('AskUserQuestion');
  });

  it('lists connected tools as sources and skips the browser', () => {
    const text = formatConnectedToolSources([
      { serverName: 'Slack', name: 'mcp__Slack__search_messages' },
      { serverName: 'Jira', name: 'mcp__Jira__list_issues' },
      { serverName: 'Chrome', name: 'mcp__Chrome__navigate' },
    ]);
    expect(text).toContain('Slack: mcp__Slack__search_messages');
    expect(text).toContain('Jira: mcp__Jira__list_issues');
    expect(text).not.toContain('navigate');
    const playbook = buildBrainstormPlaybook(detail(), [
      { serverName: 'Gmail', name: 'mcp__Gmail__search_emails' },
    ]);
    expect(playbook).toContain('Gmail: mcp__Gmail__search_emails');
    expect(playbook).toContain('mcp_search_tools');
  });

  it('parses the slash command and escapes the brief', () => {
    expect(parseBrainstormCommand('hello')).toBeNull();
    expect(parseBrainstormCommand('/brainstorm')).toBe('');
    expect(parseBrainstormCommand('/Brainstorm  pipeline design ')).toBe('pipeline design');
    const html = renderBrainstormBriefHtml(
      detail({
        topic: '<script>alert(1)</script>',
        brief: {
          summary: 'Keep it small.',
          rankedIdeaIds: [],
          experiments: [],
          openQuestions: [],
          sources: [],
        },
      })
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Keep it small.');
  });
});
