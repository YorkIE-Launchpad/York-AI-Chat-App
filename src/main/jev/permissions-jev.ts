/**
 * Permissions-adjacent Jev: MCP write class, soft ask, calendar channel score.
 */
import { JEV_MCP_WRITE_ASK_NOUL, JEV_ASK_USER_NOUL, JEV_NEEDS_EN_NOUL } from '../../shared/jev';
import { choice, isJevEnabled, noul, runJevDecision, score, type Questions } from './jev-client';

export type JevMcpAccessClass = 'read' | 'write' | 'unknown';

export async function jevClassifyMcpAccess(options: {
  toolName: string;
  serverName: string;
  description?: string;
}): Promise<JevMcpAccessClass | null> {
  if (!isJevEnabled()) return null;
  const result = await runJevDecision(
    {
      tool: options.toolName,
      server: options.serverName,
      description: (options.description || '').slice(0, 400),
    },
    {
      access: choice('Does this MCP tool read, write, or is it unclear?', {
        read: 'Read-only / list / search / get',
        write: 'Create / update / delete / send / post / mutate',
        unknown: 'Cannot tell from name/description',
      }),
    },
    { label: 'mcp-access' }
  );
  if (!result || result.answers.access?.type !== 'choice') return null;
  const c = result.answers.access.choice;
  return c === 'read' || c === 'write' || c === 'unknown' ? c : null;
}

export async function jevPermissionDisposition(options: {
  toolName: string;
  argsSummary: string;
}): Promise<'allow' | 'deny' | 'ask' | null> {
  if (!isJevEnabled()) return null;
  const questions: Questions = {
    is_write: noul('Is this a mutating / sensitive write action?'),
    disposition: choice('Permission disposition for this tool call', {
      allow: 'Safe to auto-allow',
      deny: 'Should be denied',
      ask: 'Ask the user',
    }),
  };
  const result = await runJevDecision(
    {
      tool: options.toolName,
      args: options.argsSummary.slice(0, 1000),
    },
    questions,
    { label: 'permission-disposition' }
  );
  if (!result) return null;
  const writeNoul =
    result.answers.is_write?.type === 'noul' ? result.answers.is_write.noul : 0;
  const disp =
    result.answers.disposition?.type === 'choice' ? result.answers.disposition.choice : null;
  if (disp === 'allow' || disp === 'deny' || disp === 'ask') {
    if (disp === 'allow' && writeNoul >= JEV_MCP_WRITE_ASK_NOUL) return 'ask';
    return disp;
  }
  return writeNoul >= JEV_MCP_WRITE_ASK_NOUL ? 'ask' : null;
}

export async function jevScoreCalendarChannel(options: {
  meetingTitle: string;
  attendees: string[];
  channels: Array<{ id: string; name: string }>;
}): Promise<{ channelId: string; score: number } | null> {
  if (!isJevEnabled() || options.channels.length === 0) return null;
  const slice = options.channels.slice(0, 12);
  const criteria = Object.fromEntries(
    slice.map((c) => [c.id, c.name])
  ) as Record<string, string>;
  criteria.none = 'No matching Slack channel';

  const result = await runJevDecision(
    {
      meetingTitle: options.meetingTitle,
      attendees: options.attendees.slice(0, 20),
      channels: slice,
    },
    {
      channel: choice('Best Slack channel for this meeting', criteria),
      fit: score('How strong is the channel match?', [
        'No match',
        'Weak',
        'Possible',
        'Good',
        'Exact',
      ]),
    },
    { label: 'calendar-channel' }
  );
  if (!result || result.answers.channel?.type !== 'choice') return null;
  const id = result.answers.channel.choice;
  if (id === 'none') return null;
  const fit = result.answers.fit?.type === 'score' ? result.answers.fit.score / 4 : 0.5;
  return { channelId: id, score: fit };
}

export async function jevShouldAskUser(options: {
  prompt: string;
  reason?: string;
}): Promise<boolean | null> {
  if (!isJevEnabled()) return null;
  const result = await runJevDecision(
    { prompt: options.prompt.slice(0, 2000), reason: options.reason ?? null },
    {
      ask: noul('Should the agent pause and ask the user a clarifying question now?'),
    },
    { label: 'ask-user' }
  );
  if (!result || result.answers.ask?.type !== 'noul') return null;
  return result.answers.ask.noul >= JEV_ASK_USER_NOUL;
}

export async function jevNeedsEnglishTranslation(text: string): Promise<boolean | null> {
  if (!isJevEnabled() || !text.trim()) return null;
  const result = await runJevDecision(
    { text: text.slice(0, 2000) },
    {
      needs_en: noul('Is this transcript primarily non-English and needs English translation?'),
    },
    { label: 'needs-en' }
  );
  if (!result || result.answers.needs_en?.type !== 'noul') return null;
  return result.answers.needs_en.noul >= JEV_NEEDS_EN_NOUL;
}

export async function classifyMcpToolAccessWithJev(
  toolName: string,
  description?: string
): Promise<import('../../shared/mcp-write-policy').McpToolAccessClass> {
  const { classifyMcpToolAccess, parseMcpToolName } = await import(
    '../../shared/mcp-write-policy'
  );
  const heuristic = classifyMcpToolAccess(toolName);
  if (heuristic !== 'unknown') return heuristic;
  const parsed = parseMcpToolName(toolName.toLowerCase());
  const jev = await jevClassifyMcpAccess({
    toolName,
    serverName: parsed?.serverKey || 'unknown',
    description,
  });
  return jev ?? heuristic;
}

export async function softPermissionAskWithJev(options: {
  toolName: string;
  argsSummary: string;
  fallback: 'allow' | 'deny' | 'ask';
}): Promise<'allow' | 'deny' | 'ask'> {
  const jev = await jevPermissionDisposition({
    toolName: options.toolName,
    argsSummary: options.argsSummary,
  });
  return jev ?? options.fallback;
}

export async function jevLoopGuardDisposition(options: {
  streak: number;
  recentTools: string[];
}): Promise<'continue' | 'warn' | 'halt' | 'abort' | null> {
  if (!isJevEnabled()) return null;
  const result = await runJevDecision(
    {
      streak: options.streak,
      recentTools: options.recentTools.slice(0, 20),
    },
    {
      disposition: choice('Loop-guard disposition for this agent streak', {
        continue: 'Looks healthy — continue',
        warn: 'Warn the user but continue',
        halt: 'Stop the turn gracefully',
        abort: 'Hard abort',
      }),
    },
    { label: 'loop-guard' }
  );
  if (!result || result.answers.disposition?.type !== 'choice') return null;
  const d = result.answers.disposition.choice;
  return d === 'continue' || d === 'warn' || d === 'halt' || d === 'abort' ? d : null;
}
