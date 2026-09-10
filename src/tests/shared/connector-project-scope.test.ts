import { describe, expect, it } from 'vitest';
import {
  buildConnectorScopePromptLines,
  prepareConnectorScopedMcpArgs,
} from '../../shared/connector-project-scope';
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
      'mcp__gmail__search_emails',
      { query: '' },
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('block');
    if (prepared.kind === 'block') {
      expect(prepared.message).toMatch(/Broad org-wide Gmail search/i);
      expect(prepared.message).not.toMatch(/switch to General/i);
    }
  });

  it('allows Drive get_document_content with file_id in project workspace', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__google_drive__get_document_content',
      { file_id: 'abc123xyz' },
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('allow');
  });

  it('allows Gmail get_email with message_id in project workspace', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__gmail__get_email',
      { message_id: 'msg-42' },
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('allow');
  });

  it('allows Calendar get_event with event_id in project workspace', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__google_calendar__get_event',
      { event_id: 'evt-1', calendar_id: 'primary' },
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('allow');
  });

  it('blocks empty Drive search_files in project workspace', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__google_drive__search_files',
      {},
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('block');
    if (prepared.kind === 'block') {
      expect(prepared.message).toMatch(/Broad org-wide Drive search/i);
      expect(prepared.message).not.toMatch(/Allowed drive resources/i);
      expect(prepared.message).not.toMatch(/switch to General/i);
    }
  });

  it('blocks Drive list_files without query in project workspace', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__google_drive__list_files',
      {},
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('block');
  });

  it('blocks star Drive search_files in project workspace', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__google_drive__search_files',
      { query: '*' },
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('block');
  });

  it('allows Drive search_files with project-specific query', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__google_drive__search_files',
      { query: 'RPG RevOps roadmap' },
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('allow');
  });

  it('allows Drive create_document without search or file_id', () => {
    const prepared = prepareConnectorScopedMcpArgs(
      'mcp__google_drive__create_document',
      { title: 'Notes' },
      projectSession,
      emptyProjectLinkage()
    );
    expect(prepared.kind).toBe('allow');
  });

  it('prompt lines allow attached Drive IDs and forbid broad search', () => {
    const lines = buildConnectorScopePromptLines(emptyProjectLinkage());
    expect(lines).toMatch(/user-attached references/i);
    expect(lines).toMatch(/explicit file\/message\/event IDs are allowed/i);
    expect(lines).toMatch(/broad org-wide search/i);
  });
});
