/**
 * Hard/soft scope third-party connector MCP tools in project/client workspaces.
 */
import {
  normalizeSessionDivision,
  resolveProjectAllowlist,
  type SessionDivisionFields,
} from './workspace-division';
import {
  emptyProjectLinkage,
  formatLinkageSummary,
  type ProjectLinkageMetadata,
} from './project-linkage-metadata';
import type { ProjectScopedMcpPrepare } from './project-mcp-scope';

const JIRA_PREFIXES = ['mcp__jira__'] as const;
const CONFLUENCE_PREFIXES = ['mcp__confluence__'] as const;
const SLACK_PREFIXES = ['mcp__slack__'] as const;
const GMAIL_PREFIXES = ['mcp__gmail__'] as const;
const DRIVE_PREFIXES = ['mcp__google_drive__', 'mcp__drive__'] as const;
const CALENDAR_PREFIXES = ['mcp__google_calendar__', 'mcp__calendar__'] as const;

const JIRA_KEY_ARG_KEYS = ['projectKey', 'project_key', 'project', 'projectId'] as const;
const CONFLUENCE_SPACE_ARG_KEYS = ['spaceKey', 'space_key', 'space', 'spaceId'] as const;
const SLACK_CHANNEL_ARG_KEYS = ['channel', 'channel_id', 'channelId'] as const;
const SEARCH_ARG_KEYS = ['query', 'q', 'search', 'jql', 'terms'] as const;

function connectorPrefix(toolName: string): 'jira' | 'confluence' | 'slack' | 'gmail' | 'drive' | 'calendar' | null {
  const lowered = toolName.toLowerCase();
  if (JIRA_PREFIXES.some((p) => lowered.startsWith(p))) return 'jira';
  if (CONFLUENCE_PREFIXES.some((p) => lowered.startsWith(p))) return 'confluence';
  if (SLACK_PREFIXES.some((p) => lowered.startsWith(p))) return 'slack';
  if (GMAIL_PREFIXES.some((p) => lowered.startsWith(p))) return 'gmail';
  if (DRIVE_PREFIXES.some((p) => lowered.startsWith(p))) return 'drive';
  if (CALENDAR_PREFIXES.some((p) => lowered.startsWith(p))) return 'calendar';
  return null;
}

function readArgKeys(args: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractJiraKeysFromSearch(value: string): string[] {
  const keys: string[] = [];
  const projectEq = value.match(/project\s*=\s*["']?([A-Za-z][A-Za-z0-9_-]+)["']?/gi);
  if (projectEq) {
    for (const match of projectEq) {
      const key = match.replace(/project\s*=\s*["']?/i, '').replace(/["']$/, '');
      if (key) keys.push(key);
    }
  }
  return keys;
}

function connectorRefuseMessage(
  session: Partial<SessionDivisionFields> | null | undefined,
  connector: string,
  linkage: ProjectLinkageMetadata
): string {
  const normalized = normalizeSessionDivision(session);
  const scopeLabel =
    normalized.division === 'client' && normalized.clientName
      ? `client "${normalized.clientName}"`
      : 'this project workspace';
  return [
    'Incorrect use. This attempt will be reported.',
    `Connector tool blocked in ${scopeLabel}.`,
    `Allowed ${connector} resources for this workspace: ${formatLinkageSummary(linkage)}`,
    'Use Hub/LaunchPad project tools or switch to General workspace for org-wide connector access.',
  ].join(' ');
}

function isBroadSearchQuery(query: string | null): boolean {
  if (!query) return true;
  const trimmed = query.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'in:inbox') return true;
  return trimmed.length < 3;
}

/**
 * Prepare connector MCP args for project/client division sessions.
 * When linkage metadata is empty, Jira/Confluence/Slack ID-scoped args pass with audit warn only.
 */
export function prepareConnectorScopedMcpArgs(
  toolName: string,
  args: Record<string, unknown>,
  session: Partial<SessionDivisionFields> | null | undefined,
  linkage: ProjectLinkageMetadata = emptyProjectLinkage()
): ProjectScopedMcpPrepare {
  const allowlist = resolveProjectAllowlist(session);
  if (!allowlist) {
    return { kind: 'allow', args, filterResult: false };
  }

  const kind = connectorPrefix(toolName);
  if (!kind) {
    return { kind: 'allow', args, filterResult: false };
  }

  if (kind === 'jira') {
    const projectKey = readArgKeys(args, JIRA_KEY_ARG_KEYS);
    const jql = readArgKeys(args, ['jql']);
    const keysFromJql = jql ? extractJiraKeysFromSearch(jql) : [];
    const keysToCheck = [
      ...(projectKey ? [projectKey] : []),
      ...keysFromJql,
    ];
    if (keysToCheck.length === 0) {
      return { kind: 'allow', args, filterResult: false };
    }
    if (linkage.jiraProjectKeys.size === 0) {
      return { kind: 'allow', args, filterResult: false };
    }
    for (const key of keysToCheck) {
      if (!linkage.jiraProjectKeys.has(key)) {
        return {
          kind: 'block',
          message: connectorRefuseMessage(session, 'Jira', linkage),
          attemptedProjectId: key,
        };
      }
    }
    return { kind: 'allow', args, filterResult: false };
  }

  if (kind === 'confluence') {
    const spaceKey = readArgKeys(args, CONFLUENCE_SPACE_ARG_KEYS);
    if (!spaceKey) {
      return { kind: 'allow', args, filterResult: false };
    }
    if (linkage.confluenceSpaceKeys.size === 0) {
      return { kind: 'allow', args, filterResult: false };
    }
    if (!linkage.confluenceSpaceKeys.has(spaceKey)) {
      return {
        kind: 'block',
        message: connectorRefuseMessage(session, 'Confluence', linkage),
        attemptedProjectId: spaceKey,
      };
    }
    return { kind: 'allow', args, filterResult: false };
  }

  if (kind === 'slack') {
    const channel = readArgKeys(args, SLACK_CHANNEL_ARG_KEYS);
    if (!channel) {
      return { kind: 'allow', args, filterResult: false };
    }
    if (linkage.slackChannelIds.size === 0) {
      return { kind: 'allow', args, filterResult: false };
    }
    if (!linkage.slackChannelIds.has(channel)) {
      return {
        kind: 'block',
        message: connectorRefuseMessage(session, 'Slack', linkage),
        attemptedProjectId: channel,
      };
    }
    return { kind: 'allow', args, filterResult: false };
  }

  if (kind === 'gmail' || kind === 'drive' || kind === 'calendar') {
    const search = readArgKeys(args, SEARCH_ARG_KEYS);
    if (isBroadSearchQuery(search)) {
      return {
        kind: 'block',
        message: [
          connectorRefuseMessage(session, kind, linkage),
          'Narrow the search to project-specific terms or switch to General workspace.',
        ].join(' '),
      };
    }
    return { kind: 'allow', args, filterResult: false };
  }

  return { kind: 'allow', args, filterResult: false };
}

export function buildConnectorScopePromptLines(linkage: ProjectLinkageMetadata): string {
  const summary = formatLinkageSummary(linkage);
  if (summary.startsWith('No linked')) {
    return [
      'Connector tools (Slack, Gmail, Jira, Confluence, Drive, Calendar): use only resources clearly tied to this project/client.',
      'Broad org-wide searches are forbidden in this workspace.',
    ].join(' ');
  }
  return [
    'Connector tools are restricted to linked project resources:',
    summary,
    'Do not query other clients, projects, channels, or inboxes.',
  ].join(' ');
}
