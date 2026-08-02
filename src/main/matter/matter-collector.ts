import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import { log, logWarn } from '../utils/logger';
import {
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
  DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  DEFAULT_HUB_MCP_SERVER_ID,
  DEFAULT_JIRA_MCP_SERVER_ID,
  DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../shared/mcp-defaults';
import type {
  MatterCategory,
  MatterConfigurableSource,
  MatterOrbit,
  MatterSeverity,
  MatterSource,
  MatterSourceRef,
  MatterSourcesConfig,
} from '../../shared/matter';
import type { WelcomeProfile } from '../../shared/welcome-actions';

export interface RawMatterSignal {
  fingerprint: string;
  source: MatterSource;
  title: string;
  summary: string;
  rawExcerpt?: string;
  severityHint?: MatterSeverity;
  orbitHint?: MatterOrbit;
  categoryHint?: MatterCategory;
  whyHint?: string;
  suggestedAction?: string;
  sourceRef?: MatterSourceRef;
  expiresAt?: number | null;
  muteKeys?: string[];
}

export interface CollectSignalsResult {
  signals: RawMatterSignal[];
  sourcesChecked: string[];
  sourcesSkipped: string[];
}

function truncate(value: unknown, max = 1200): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function findToolName(mcpManager: MCPManager, serverId: string, hints: string[]): string | null {
  const tools = mcpManager.getTools().filter((t) => t.serverId === serverId);
  for (const hint of hints) {
    const lower = hint.toLowerCase();
    const match = tools.find((t) => {
      const original = (t.originalName || '').toLowerCase();
      const name = t.name.toLowerCase();
      return original === lower || original.includes(lower) || name.includes(lower);
    });
    if (match) return match.name;
  }
  return null;
}

async function safeCallTool(
  mcpManager: MCPManager,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown | null> {
  try {
    return await mcpManager.callTool(toolName, args);
  } catch (error) {
    logWarn(`[Matter] Tool call failed (${toolName}):`, error);
    return null;
  }
}

function isServerConnected(mcpManager: MCPManager, serverId: string): boolean {
  return mcpManager.getServerStatus().some((s) => s.id === serverId && s.connected);
}

function signalFromText(input: {
  fingerprint: string;
  source: MatterSource;
  title: string;
  summary: string;
  raw?: unknown;
  severityHint?: MatterSeverity;
  orbitHint?: MatterOrbit;
  categoryHint?: MatterCategory;
  whyHint?: string;
  suggestedAction?: string;
  sourceRef?: MatterSourceRef;
  muteKeys?: string[];
}): RawMatterSignal {
  return {
    fingerprint: input.fingerprint,
    source: input.source,
    title: input.title,
    summary: input.summary,
    rawExcerpt: input.raw !== undefined ? truncate(input.raw) : undefined,
    severityHint: input.severityHint,
    orbitHint: input.orbitHint,
    categoryHint: input.categoryHint,
    whyHint: input.whyHint,
    suggestedAction: input.suggestedAction,
    sourceRef: input.sourceRef,
    muteKeys: input.muteKeys,
  };
}

async function collectCalendar(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID, [
    'list_events',
    'listEvents',
    'search_events',
  ]);
  if (!tool) return [];
  const now = new Date();
  const end = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const result = await safeCallTool(mcpManager, tool, {
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    maxResults: 12,
    singleEvents: true,
    orderBy: 'startTime',
  });
  if (!result) return [];
  const text = truncate(result, 4000);
  const signals: RawMatterSignal[] = [
    signalFromText({
      fingerprint: `calendar:window:${now.toISOString().slice(0, 13)}`,
      source: 'calendar',
      title: 'Upcoming calendar pressure (next 48h)',
      summary: 'Meetings and conflicts in your near-term calendar window.',
      raw: text,
      severityHint: /conflict|overlap|back.to.back/i.test(text) ? 'warning' : 'signal',
      orbitHint: 'today',
      categoryHint: 'time',
      whyHint: profile?.title
        ? `Your schedule as ${profile.title} shapes what you can take on today.`
        : 'Calendar load shapes focus windows.',
      suggestedAction: 'Prep the next meeting or resolve conflicts.',
      sourceRef: { connectorId: DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID, label: 'Calendar' },
      muteKeys: ['source:calendar'],
    }),
  ];
  return signals;
}

async function collectSlack(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
    'search_messages',
    'searchMessages',
  ]);
  if (!tool) return [];
  const queryParts = ['is:dm OR has:reaction', 'after:yesterday'];
  if (profile?.name) queryParts.unshift(profile.name.split(' ')[0]);
  const result = await safeCallTool(mcpManager, tool, {
    query: 'in:@me OR to:me after:yesterday',
    limit: 10,
    count: 10,
  });
  if (!result) return [];
  const text = truncate(result, 4000);
  if (/no messages|0 results|nothing found/i.test(text) && text.length < 80) return [];
  return [
    signalFromText({
      fingerprint: `slack:mentions:${new Date().toISOString().slice(0, 10)}`,
      source: 'slack',
      title: 'Slack threads that may need a reply',
      summary: 'Recent DMs / mentions that look like open loops.',
      raw: text,
      severityHint: /urgent|asap|blocker|please reply|waiting on you/i.test(text)
        ? 'warning'
        : 'signal',
      orbitHint: 'today',
      categoryHint: 'comms',
      whyHint: 'Unanswered Slack loops create commitment debt.',
      suggestedAction: 'Reply or snooze with a follow-up.',
      sourceRef: { connectorId: DEFAULT_SLACK_MCP_SERVER_ID, label: 'Slack' },
      muteKeys: ['source:slack'],
    }),
  ];
}

async function collectGmail(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
    'search_emails',
    'searchEmails',
    'list_emails',
  ]);
  if (!tool) return [];
  const result = await safeCallTool(mcpManager, tool, {
    query: 'is:unread newer_than:2d -category:promotions -category:social',
    maxResults: 10,
    limit: 10,
  });
  if (!result) return [];
  const text = truncate(result, 4000);
  if (/0 messages|no emails|no results/i.test(text) && text.length < 80) return [];
  return [
    signalFromText({
      fingerprint: `gmail:unread:${new Date().toISOString().slice(0, 10)}`,
      source: 'gmail',
      title: 'Unread email needing triage',
      summary: 'Recent unread threads that may require a response.',
      raw: text,
      severityHint: /urgent|action required|invoice|escalat/i.test(text) ? 'warning' : 'signal',
      orbitHint: 'today',
      categoryHint: /client|customer|proposal/i.test(text) ? 'client' : 'comms',
      whyHint: profile?.email
        ? `Inbox for ${profile.email} has unread work threads.`
        : 'Unread mail may hide commitments.',
      suggestedAction: 'Triage unread threads or draft replies.',
      sourceRef: { connectorId: DEFAULT_GMAIL_MCP_SERVER_ID, label: 'Gmail' },
      muteKeys: ['source:gmail'],
    }),
  ];
}

async function collectJira(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID, [
    'searchJiraIssuesUsingJql',
    'search_jira',
    'jira_search',
  ]);
  if (!tool) return [];
  const jql =
    'assignee = currentUser() AND resolution = Unresolved AND updated >= -7d ORDER BY priority DESC, updated DESC';
  const result = await safeCallTool(mcpManager, tool, {
    jql,
    maxResults: 15,
    fields: ['summary', 'status', 'priority', 'assignee', 'duedate', 'issuetype'],
  });
  if (!result) return [];
  const text = truncate(result, 4500);
  if (/total["']?\s*:\s*0|no issues/i.test(text) && text.length < 120) return [];
  const blocked = /blocked|blocker|highest|critical/i.test(text);
  return [
    signalFromText({
      fingerprint: `jira:assigned:${new Date().toISOString().slice(0, 10)}`,
      source: 'jira',
      title: blocked
        ? 'Jira blockers / high-priority work on you'
        : 'Open Jira work assigned to you',
      summary: 'Unresolved issues assigned to you from the last week.',
      raw: text,
      severityHint: blocked ? 'critical' : 'warning',
      orbitHint: blocked ? 'now' : 'today',
      categoryHint: 'delivery',
      whyHint: profile?.title
        ? `Delivery ownership for ${profile.title}${profile.squad ? ` · ${profile.squad}` : ''}.`
        : 'Assigned Jira work is on your critical path.',
      suggestedAction: 'Unblock or update status on top issues.',
      sourceRef: { connectorId: DEFAULT_JIRA_MCP_SERVER_ID, label: 'Jira' },
      muteKeys: ['source:jira', 'category:delivery'],
    }),
  ];
}

async function collectHub(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const signals: RawMatterSignal[] = [];
  const teamTool = findToolName(mcpManager, DEFAULT_HUB_MCP_SERVER_ID, [
    'get_employee_team',
    'getEmployeeTeam',
  ]);
  if (teamTool) {
    const team = await safeCallTool(mcpManager, teamTool, {
      email: profile?.email,
    });
    if (team) {
      signals.push(
        signalFromText({
          fingerprint: `hub:team:${profile?.email || 'me'}`,
          source: 'hub',
          title: 'Team / reporting context',
          summary: 'Your Hub team graph for people gravity.',
          raw: team,
          severityHint: 'signal',
          orbitHint: 'watching',
          categoryHint: 'people',
          whyHint: 'Reporting lines change what people issues matter to you.',
          sourceRef: { connectorId: DEFAULT_HUB_MCP_SERVER_ID, label: 'Hub team' },
          muteKeys: ['source:hub', 'category:people'],
        })
      );
    }
  }

  const leaveTool = findToolName(mcpManager, DEFAULT_HUB_MCP_SERVER_ID, [
    'get_leave_wfh_calendar',
    'leave_wfh',
  ]);
  if (leaveTool) {
    const leave = await safeCallTool(mcpManager, leaveTool, {
      days: 7,
    });
    if (leave) {
      const text = truncate(leave);
      signals.push(
        signalFromText({
          fingerprint: `hub:leave:${new Date().toISOString().slice(0, 10)}`,
          source: 'hub',
          title: 'Team leave / WFH this week',
          summary: 'Who is out or remote — coverage and 1:1 impact.',
          raw: text,
          severityHint: /leave|ooo|out of office/i.test(text) ? 'warning' : 'healthy',
          orbitHint: 'week',
          categoryHint: 'people',
          whyHint: 'Coverage gaps and meeting prep depend on who is around.',
          suggestedAction: 'Adjust plans for people who are out.',
          sourceRef: { connectorId: DEFAULT_HUB_MCP_SERVER_ID, label: 'Hub leave' },
          muteKeys: ['source:hub:leave'],
        })
      );
    }
  }
  return signals;
}

async function collectDrive(mcpManager: MCPManager): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, [
    'search_files',
    'searchFiles',
  ]);
  if (!tool) return [];
  const result = await safeCallTool(mcpManager, tool, {
    query: 'modifiedTime > consecutive_daysAgo(3)',
    pageSize: 8,
  });
  // Drive query dialects vary — try a simpler fallback
  const data =
    result ||
    (await safeCallTool(mcpManager, tool, {
      query: 'sharedWithMe = true',
      pageSize: 8,
    }));
  if (!data) return [];
  return [
    signalFromText({
      fingerprint: `drive:recent:${new Date().toISOString().slice(0, 10)}`,
      source: 'drive',
      title: 'Docs recently shared or updated',
      summary: 'Drive activity that may need review.',
      raw: data,
      severityHint: 'signal',
      orbitHint: 'week',
      categoryHint: 'admin',
      suggestedAction: 'Review shared docs awaiting feedback.',
      sourceRef: { connectorId: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, label: 'Drive' },
      muteKeys: ['source:drive'],
    }),
  ];
}

async function collectLaunchpad(mcpManager: MCPManager): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_LAUNCHPAD_MCP_SERVER_ID, [
    'list_releases',
    'get_active_release',
    'list_features',
    'search',
  ]);
  if (!tool) return [];
  const result = await safeCallTool(mcpManager, tool, {});
  if (!result) return [];
  const text = truncate(result);
  return [
    signalFromText({
      fingerprint: `launchpad:active:${new Date().toISOString().slice(0, 10)}`,
      source: 'launchpad',
      title: 'Launchpad delivery pulse',
      summary: 'Active release / delivery signals from R&D Launchpad.',
      raw: text,
      severityHint: /risk|blocked|failed|critical/i.test(text) ? 'warning' : 'signal',
      orbitHint: 'today',
      categoryHint: 'delivery',
      suggestedAction: 'Check active release health.',
      sourceRef: { connectorId: DEFAULT_LAUNCHPAD_MCP_SERVER_ID, label: 'Launchpad' },
      muteKeys: ['source:launchpad'],
    }),
  ];
}

function collectMeetings(meetingService: MeetingService | null): RawMatterSignal[] {
  if (!meetingService) return [];
  try {
    const listed = meetingService.list().slice(0, 12);
    const signals: RawMatterSignal[] = [];
    for (const item of listed) {
      const meeting = meetingService.get(item.id);
      const actions = meeting?.notes?.actionItems || [];
      if (!meeting || actions.length === 0) continue;
      signals.push(
        signalFromText({
          fingerprint: `meeting:actions:${meeting.id}`,
          source: 'meeting',
          title: `Open actions from ${meeting.title || 'recent meeting'}`,
          summary: actions.slice(0, 3).join('; '),
          raw: { summary: meeting.notes?.summary, actionItems: actions },
          severityHint: 'warning',
          orbitHint: 'today',
          categoryHint: 'time',
          whyHint: 'Meeting action items still open after capture.',
          suggestedAction: 'Close or delegate remaining action items.',
          sourceRef: {
            externalId: meeting.id,
            label: meeting.title || 'Meeting',
          },
          muteKeys: [`meeting:${meeting.id}`, 'source:meeting'],
        })
      );
      if (signals.length >= 5) break;
    }
    return signals;
  } catch (error) {
    logWarn('[Matter] Meeting collect failed:', error);
    return [];
  }
}

/** Conflict fusion: if calendar + jira both hot, emit a fused signal. */
function fuseConflicts(signals: RawMatterSignal[]): RawMatterSignal[] {
  const cal = signals.find((s) => s.source === 'calendar');
  const jira = signals.find((s) => s.source === 'jira' && s.severityHint === 'critical');
  if (!cal || !jira) return signals;
  return [
    ...signals,
    signalFromText({
      fingerprint: `fused:calendar-jira:${new Date().toISOString().slice(0, 10)}`,
      source: 'fused',
      title: 'Schedule pressure vs delivery blockers',
      summary: 'Calendar load overlaps with critical Jira ownership — focus window is tight.',
      raw: { calendar: cal.title, jira: jira.title },
      severityHint: 'critical',
      orbitHint: 'now',
      categoryHint: 'delivery',
      whyHint: 'When blockers collide with a packed calendar, something slips unless you choose.',
      suggestedAction: 'Protect a focus block or renegotiate a meeting.',
      sourceRef: { label: 'Fused signal' },
      muteKeys: ['fused:calendar-jira'],
    }),
  ];
}

const SOURCE_SERVER: Record<MatterConfigurableSource, string | null> = {
  calendar: DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
  slack: DEFAULT_SLACK_MCP_SERVER_ID,
  gmail: DEFAULT_GMAIL_MCP_SERVER_ID,
  jira: DEFAULT_JIRA_MCP_SERVER_ID,
  hub: DEFAULT_HUB_MCP_SERVER_ID,
  meeting: null,
  drive: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  launchpad: DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
};

export async function collectMatterSignals(options: {
  mcpManager: MCPManager | null;
  meetingService: MeetingService | null;
  profile: WelcomeProfile | null;
  sources: MatterSourcesConfig;
}): Promise<CollectSignalsResult> {
  const { mcpManager, meetingService, profile, sources } = options;
  const sourcesChecked: string[] = [];
  const sourcesSkipped: string[] = [];
  const signals: RawMatterSignal[] = [];

  const run = async (
    key: MatterConfigurableSource,
    fn: () => Promise<RawMatterSignal[]> | RawMatterSignal[]
  ) => {
    if (!sources[key]) {
      sourcesSkipped.push(key);
      return;
    }
    const serverId = SOURCE_SERVER[key];
    if (serverId && (!mcpManager || !isServerConnected(mcpManager, serverId))) {
      sourcesSkipped.push(key);
      return;
    }
    if (key === 'meeting' && !meetingService) {
      sourcesSkipped.push(key);
      return;
    }
    try {
      const batch = await fn();
      if (batch.length) {
        sourcesChecked.push(key);
        signals.push(...batch);
      } else {
        sourcesChecked.push(key);
      }
    } catch (error) {
      logWarn(`[Matter] Source ${key} failed:`, error);
      sourcesSkipped.push(key);
    }
  };

  if (!mcpManager) {
    for (const key of Object.keys(sources) as MatterConfigurableSource[]) {
      if (key !== 'meeting') sourcesSkipped.push(key);
    }
  } else {
    await Promise.all([
      run('calendar', () => collectCalendar(mcpManager, profile)),
      run('slack', () => collectSlack(mcpManager, profile)),
      run('gmail', () => collectGmail(mcpManager, profile)),
      run('jira', () => collectJira(mcpManager, profile)),
      run('hub', () => collectHub(mcpManager, profile)),
      run('drive', () => collectDrive(mcpManager)),
      run('launchpad', () => collectLaunchpad(mcpManager)),
    ]);
  }

  await run('meeting', () => collectMeetings(meetingService));

  const fused = fuseConflicts(signals);
  log(
    `[Matter] Collected ${fused.length} signals (checked=${sourcesChecked.join(',') || 'none'}; skipped=${sourcesSkipped.join(',') || 'none'})`
  );
  return { signals: fused, sourcesChecked, sourcesSkipped };
}
