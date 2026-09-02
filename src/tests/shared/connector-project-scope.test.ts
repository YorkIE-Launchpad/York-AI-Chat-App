import { describe, expect, it } from 'vitest';
import { prepareConnectorScopedMcpArgs } from '../../shared/connector-project-scope';
import { emptyProjectLinkage } from '../../shared/project-linkage-metadata';

const projectSession = {
  division: 'project' as const,
  hubProjectId: 'alpha-id',
  hubProjectName: 'Alpha',
};

describe('connector-project-scope', () => {
  it('passes through outside project/client division', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__jira__search_issues',
      { jql: 'project = WRONG' },
      { division: 'general' }
    );
    expect(prepared.kind).toBe('allow');
  });

  it('blocks Jira project key outside linkage allowlist', () => {
    const linkage = emptyProjectLinkage();
    linkage.jiraProjectKeys.add('ALPHA');
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__jira__get_issue',
      { projectKey: 'OTHER' },
      projectSession,
      linkage
    );
    expect(prepared.kind).toBe('block');
  });

  it('allows Jira project key in linkage allowlist', () => {
    const linkage = emptyProjectLinkage();
    linkage.jiraProjectKeys.add('ALPHA');
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__jira__get_issue',
      { projectKey: 'ALPHA' },
      projectSession,
      linkage
    );
    expect(prepared.kind).toBe('allow');
  });

  it('blocks broad Gmail search in project workspace', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__gmail__search_messages',
      { query: '' },
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('block');
  });
});
