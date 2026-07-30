import { describe, expect, it } from 'vitest';
import {
  filterAtlassianToolsByProduct,
  isShareableAtlassianRemoteMcpServer,
  normalizeAtlassianMcpShareUrl,
} from '../../main/mcp/atlassian-mcp-tools';

const SAMPLE_TOOLS = [
  { name: 'atlassianUserInfo' },
  { name: 'getAccessibleAtlassianResources' },
  { name: 'searchAtlassian' },
  { name: 'fetchAtlassian' },
  { name: 'getJiraIssue' },
  { name: 'searchJiraIssuesUsingJql' },
  { name: 'createJiraIssue' },
  { name: 'getConfluencePage' },
  { name: 'searchConfluenceUsingCql' },
  { name: 'createConfluencePage' },
  { name: 'getJsmOpsAlerts' },
  { name: 'bitbucketPullRequest' },
  { name: 'getCompassComponent' },
  { name: 'getTeamworkGraphContext' },
];

describe('filterAtlassianToolsByProduct', () => {
  it('keeps Jira + shared tools and drops Confluence / JSM / Bitbucket / Compass', () => {
    const filtered = filterAtlassianToolsByProduct(SAMPLE_TOOLS, 'jira').map((t) => t.name);
    expect(filtered).toEqual([
      'atlassianUserInfo',
      'getAccessibleAtlassianResources',
      'searchAtlassian',
      'fetchAtlassian',
      'getJiraIssue',
      'searchJiraIssuesUsingJql',
      'createJiraIssue',
    ]);
  });

  it('keeps Confluence + shared tools and drops Jira / JSM / Bitbucket / Compass', () => {
    const filtered = filterAtlassianToolsByProduct(SAMPLE_TOOLS, 'confluence').map((t) => t.name);
    expect(filtered).toEqual([
      'atlassianUserInfo',
      'getAccessibleAtlassianResources',
      'searchAtlassian',
      'fetchAtlassian',
      'getConfluencePage',
      'searchConfluenceUsingCql',
      'createConfluencePage',
    ]);
  });
});

describe('normalizeAtlassianMcpShareUrl', () => {
  it('strips trailing slashes and lowercases host', () => {
    expect(normalizeAtlassianMcpShareUrl('https://MCP.Atlassian.com/v1/mcp/authv2/')).toBe(
      'https://mcp.atlassian.com/v1/mcp/authv2'
    );
  });

  it('treats equivalent URLs as the same share key', () => {
    const a = normalizeAtlassianMcpShareUrl('https://mcp.atlassian.com/v1/mcp/authv2');
    const b = normalizeAtlassianMcpShareUrl('https://mcp.atlassian.com/v1/mcp/authv2/');
    expect(a).toBe(b);
  });
});

describe('isShareableAtlassianRemoteMcpServer', () => {
  it('matches built-in Jira/Confluence streamable-http rows', () => {
    expect(
      isShareableAtlassianRemoteMcpServer({
        name: 'Jira',
        type: 'streamable-http',
        url: 'https://mcp.atlassian.com/v1/mcp/authv2',
      })
    ).toBe(true);
    expect(
      isShareableAtlassianRemoteMcpServer({
        name: 'Confluence',
        type: 'streamable-http',
        url: 'https://mcp.atlassian.com/v1/mcp/authv2',
      })
    ).toBe(true);
  });

  it('rejects non-Atlassian or non-http rows', () => {
    expect(
      isShareableAtlassianRemoteMcpServer({
        name: 'Hub',
        type: 'streamable-http',
        url: 'https://example.com/mcp',
      })
    ).toBe(false);
    expect(
      isShareableAtlassianRemoteMcpServer({
        name: 'Jira',
        type: 'stdio',
        url: undefined,
      })
    ).toBe(false);
  });
});
