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

/** Concrete resource IDs — ID-scoped reads/writes are allowed in project workspaces. */
const RESOURCE_ID_ARG_KEYS = [
  'file_id',
  'message_id',
  'event_id',
  'draft_id',
  'reply_to_message_id',
  'parent_folder_id',
] as const;

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

/** Refuse copy for Drive/Gmail/Calendar — these have no Hub linkage allowlist. */
function broadSearchRefuseMessage(
  session: Partial<SessionDivisionFields> | null | undefined,
  connector: 'gmail' | 'drive' | 'calendar'
): string {
  const normalized = normalizeSessionDivision(session);
  const scopeLabel =
    normalized.division === 'client' && normalized.clientName
      ? `client "${normalized.clientName}"`
      : 'this project workspace';
  const label =
    connector === 'drive' ? 'Drive' : connector === 'gmail' ? 'Gmail' : 'Calendar';
  return [
    'Incorrect use. This attempt will be reported.',
    `Broad org-wide ${label} search is blocked in ${scopeLabel}.`,
    'Narrow the search to project-specific terms (3+ characters).',
    'Explicit file/message/event IDs and user-attached references are allowed.',
  ].join(' ');
}

function isBroadSearchQuery(query: string | null): boolean {
  if (!query) return true;
  const trimmed = query.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'in:inbox') return true;
  return trimmed.length < 3;
}

/** True when the tool leaf name is a search or list operation. */
function isSearchOrListTool(toolName: string): boolean {
  const leaf = toolName.toLowerCase().split('__').pop() || toolName.toLowerCase();
  return (
    leaf.startsWith('search_') ||
    leaf.startsWith('list_') ||
    leaf === 'search' ||
    leaf === 'list'
  );
}

/**
 * Prepare connector MCP args for project/client division sessions.
 * When linkage metadata is empty, Jira/Confluence/Slack ID-scoped args pass with audit warn only.
 * Drive/Gmail/Calendar: ID-scoped calls and specific searches are allowed; broad search/list is blocked.
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
    // Explicit resource IDs (and user-attached Drive/Gmail/Calendar refs) are allowed.
    if (readArgKeys(args, RESOURCE_ID_ARG_KEYS)) {
      return { kind: 'allow', args, filterResult: false };
    }

    const search = readArgKeys(args, SEARCH_ARG_KEYS);
    if (search !== null) {
      if (isBroadSearchQuery(search)) {
        return {
          kind: 'block',
          message: broadSearchRefuseMessage(session, kind),
        };
      }
      return { kind: 'allow', args, filterResult: false };
    }

    // No search arg and no resource ID: block only search/list tools (org-wide crawl).
    if (isSearchOrListTool(toolName)) {
      return {
        kind: 'block',
        message: broadSearchRefuseMessage(session, kind),
      };
    }

    return { kind: 'allow', args, filterResult: false };
  }

  return { kind: 'allow', args, filterResult: false };
}

export function buildConnectorScopePromptLines(linkage: ProjectLinkageMetadata): string {
  const summary = formatLinkageSummary(linkage);
  const driveGmailCalendar =
    'Drive/Gmail/Calendar: user-attached references and explicit file/message/event IDs are allowed; broad org-wide search or list is forbidden.';
  if (summary.startsWith('No linked')) {
    return [
      'Connector tools (Slack, Jira, Confluence): use only resources clearly tied to this project/client.',
      driveGmailCalendar,
      'Broad org-wide searches are forbidden in this workspace.',
    ].join(' ');
  }
  return [
    'Connector tools are restricted to linked project resources:',
    summary,
    driveGmailCalendar,
    'Do not query other clients, projects, channels, or inboxes.',
  ].join(' ');
}
