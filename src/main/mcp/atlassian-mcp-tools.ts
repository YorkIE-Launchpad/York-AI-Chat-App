/**
 * Filter Atlassian Rovo MCP tools so Jira / Confluence catalog entries only
 * expose their product tools (+ shared discovery helpers).
 */

const SHARED_ATLASSIAN_TOOLS = new Set([
  'atlassianuserinfo',
  'getaccessibleatlassianresources',
  'searchatlassian',
  'fetchatlassian',
]);

export type AtlassianProductFilter = 'jira' | 'confluence';

export function filterAtlassianToolsByProduct<T extends { name?: string }>(
  tools: T[],
  product: AtlassianProductFilter
): T[] {
  const productNeedle = product === 'jira' ? 'jira' : 'confluence';
  return tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) return false;
    const lowered = name.toLowerCase();
    if (SHARED_ATLASSIAN_TOOLS.has(lowered)) return true;
    return lowered.includes(productNeedle);
  });
}
