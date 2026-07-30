import { describe, expect, it } from 'vitest';
import {
  ATLASSIAN_MCP_RUN_TIMEOUT_MS,
  mentionsAtlassianMcp,
  resolveMcpRunTimeoutMs,
} from '../../main/agent/mcp-run-timeout';
import {
  DEFAULT_CHILD_TIMEOUT_MS,
  MAX_CHILD_TIMEOUT_MS,
} from '../../main/agent/child-agent-session';

describe('mentionsAtlassianMcp', () => {
  it('detects server hints', () => {
    expect(mentionsAtlassianMcp('list pages', 'Confluence')).toBe(true);
    expect(mentionsAtlassianMcp(undefined, 'Jira')).toBe(true);
  });

  it('detects goal keywords', () => {
    expect(mentionsAtlassianMcp('Fetch the latest Confluence page about onboarding')).toBe(true);
    expect(mentionsAtlassianMcp('search jira for open bugs')).toBe(true);
    expect(mentionsAtlassianMcp('use Atlassian to find the doc')).toBe(true);
  });

  it('ignores unrelated goals', () => {
    expect(mentionsAtlassianMcp('list Hub leave balances', 'York IE HUB')).toBe(false);
    expect(mentionsAtlassianMcp('search Slack for Jay')).toBe(false);
  });
});

describe('resolveMcpRunTimeoutMs', () => {
  it('defaults to 120s for non-Atlassian goals', () => {
    expect(resolveMcpRunTimeoutMs({ goal: 'list Hub leave' })).toBe(DEFAULT_CHILD_TIMEOUT_MS);
  });

  it('defaults to 240s when server is Confluence', () => {
    expect(resolveMcpRunTimeoutMs({ goal: 'get page', server: 'Confluence' })).toBe(
      ATLASSIAN_MCP_RUN_TIMEOUT_MS
    );
  });

  it('defaults to 240s when goal mentions Jira/Confluence/Atlassian', () => {
    expect(resolveMcpRunTimeoutMs({ goal: 'get Confluence page X' })).toBe(
      ATLASSIAN_MCP_RUN_TIMEOUT_MS
    );
  });

  it('lets explicit timeout_seconds win (clamped to max)', () => {
    expect(resolveMcpRunTimeoutMs({ goal: 'get Confluence page', timeoutSeconds: 90 })).toBe(
      90_000
    );
    expect(resolveMcpRunTimeoutMs({ goal: 'list Hub leave', timeoutSeconds: 90 })).toBe(90_000);
    expect(resolveMcpRunTimeoutMs({ goal: 'anything', timeoutSeconds: 999 })).toBe(
      MAX_CHILD_TIMEOUT_MS
    );
  });

  it('clamps explicit timeout to at least 10s', () => {
    expect(resolveMcpRunTimeoutMs({ goal: 'x', timeoutSeconds: 1 })).toBe(10_000);
  });
});
