import { describe, expect, it } from 'vitest';
import { filterAtlassianToolsByProduct } from '../../main/mcp/atlassian-mcp-tools';

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
