/**
 * Extract Jira/Confluence/Slack linkage from Hub project payloads for connector scoping.
 */
import { resolveProjectAllowlist, type SessionDivisionFields } from './workspace-division';

export interface ProjectLinkageMetadata {
  jiraProjectKeys: Set<string>;
  confluenceSpaceKeys: Set<string>;
  slackChannelIds: Set<string>;
}

export function emptyProjectLinkage(): ProjectLinkageMetadata {
  return {
    jiraProjectKeys: new Set(),
    confluenceSpaceKeys: new Set(),
    slackChannelIds: new Set(),
  };
}

function addString(set: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    set.add(value.trim());
  }
}

function walkForLinkage(value: unknown, linkage: ProjectLinkageMetadata, depth = 0): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkForLinkage(item, linkage, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const rec = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(rec)) {
    const lowered = key.toLowerCase();
    if (
      lowered === 'jiraprojectkey' ||
      lowered === 'jira_project_key' ||
      lowered === 'projectkey' ||
      lowered === 'jira_key'
    ) {
      addString(linkage.jiraProjectKeys, nested);
    }
    if (
      lowered === 'confluencespacekey' ||
      lowered === 'confluence_space_key' ||
      lowered === 'spacekey' ||
      lowered === 'space_key'
    ) {
      addString(linkage.confluenceSpaceKeys, nested);
    }
    if (
      lowered === 'slackchannelid' ||
      lowered === 'slack_channel_id' ||
      lowered === 'channelid' ||
      lowered === 'channel_id'
    ) {
      addString(linkage.slackChannelIds, nested);
    }
    if (typeof nested === 'object' && nested !== null) {
      walkForLinkage(nested, linkage, depth + 1);
    }
  }
}

/** Best-effort extraction from Hub get_project JSON. */
export function extractProjectLinkageFromHubPayload(payload: unknown): ProjectLinkageMetadata {
  const linkage = emptyProjectLinkage();
  walkForLinkage(payload, linkage);
  return linkage;
}

export function mergeLinkageForSession(
  cache: ReadonlyMap<string, ProjectLinkageMetadata>,
  session: Partial<SessionDivisionFields> | null | undefined
): ProjectLinkageMetadata {
  const allowlist = resolveProjectAllowlist(session);
  const merged = emptyProjectLinkage();
  if (!allowlist) return merged;
  for (const hubId of allowlist.hubIds) {
    const entry = cache.get(hubId);
    if (!entry) continue;
    for (const key of entry.jiraProjectKeys) merged.jiraProjectKeys.add(key);
    for (const key of entry.confluenceSpaceKeys) merged.confluenceSpaceKeys.add(key);
    for (const id of entry.slackChannelIds) merged.slackChannelIds.add(id);
  }
  return merged;
}

export function formatLinkageSummary(linkage: ProjectLinkageMetadata): string {
  const parts: string[] = [];
  if (linkage.jiraProjectKeys.size) {
    parts.push(`Jira keys: ${Array.from(linkage.jiraProjectKeys).join(', ')}`);
  }
  if (linkage.confluenceSpaceKeys.size) {
    parts.push(`Confluence spaces: ${Array.from(linkage.confluenceSpaceKeys).join(', ')}`);
  }
  if (linkage.slackChannelIds.size) {
    parts.push(`Slack channels: ${Array.from(linkage.slackChannelIds).join(', ')}`);
  }
  return parts.join('; ') || 'No linked connector resources known for this project.';
}
