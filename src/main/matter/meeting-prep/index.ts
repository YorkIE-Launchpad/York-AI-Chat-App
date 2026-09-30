/**
 * Meeting prep pipeline: classify recurring vs one-off, gather evidence
 * (series history + action-item checks, or party research), synthesize an
 * agenda-first brief, and render it with numbered sources.
 */

import type { AppConfig } from '../../config/config-store';
import type { MCPManager } from '../../mcp/mcp-manager';
import type { MeetingService } from '../../meetings/meeting-service';
import { log } from '../../utils/logger';
import { displayName } from '../matter-calendar-enrichment';
import { classifyMeeting, detectRecurrence } from './classify';
import { envelopeBody } from './connectors';
import { buildFallbackBrief } from './fallback';
import { ConnectorTracker, gatherMeetingContext, otherAttendees, type GatherDeps } from './gather';
import { researchParties } from './party-research';
import { formatWhen, renderPrepBrief } from './render';
import {
  filterSeriesInstances,
  loadSeriesHistory,
  searchPastCalendarEvents,
} from './series-history';
import { synthesizePrepBrief } from './synthesize';
import {
  EvidencePool,
  type CalendarAttendee,
  type ConnectorPrepStatus,
  type MeetingKind,
  type MeetingPrepContext,
  type PartyProfile,
  type PrepBrief,
  type PrepEvidence,
  type SeriesHistory,
} from './types';
import { gatherActionEvidence } from './verify-actions';

export type { MeetingKind, PrepBrief, PrepEvidence } from './types';

const ONE_OFF_LOOKBACK_DAYS = 30;
const RECURRING_DEFAULT_LOOKBACK_DAYS = 14;

export interface RunMeetingPrepInput {
  mcpManager: MCPManager;
  meetingService: MeetingService | null;
  config?: AppConfig | null;
  selfEmail?: string | null;
  eventId?: string | null;
  originalTitle: string;
  when: string;
  attendees: CalendarAttendee[];
  eventUrl?: string;
  inviteBody?: string;
}

export interface MeetingPrepResult {
  kind: MeetingKind;
  cadence: string | null;
  lastHeld: string | null;
  prepNote: string;
  summary: string;
  suggestedAction: string;
  brief: PrepBrief;
  evidence: PrepEvidence[];
  connectors: ConnectorPrepStatus[];
  usedFallback: boolean;
}

function startIsoFromWhen(when: string): string | null {
  const start = when.split('→')[0]?.trim();
  const ms = start ? Date.parse(start) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Invite description without connector metadata lines. */
export function inviteDescription(inviteBody: string): string {
  return envelopeBody(inviteBody)
    .split('\n')
    .filter(
      (line) =>
        !/^(Link|Meet|Location|Attendees|RecurringEventId|Recurrence|RRULE):/i.test(line.trim()) &&
        !/^[^\s:]+:\s.*\([^)]*→[^)]*\)\s*$/.test(line.trim())
    )
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function runMeetingPrep(input: RunMeetingPrepInput): Promise<MeetingPrepResult> {
  const inviteBody = input.inviteBody || '';
  const ctx: MeetingPrepContext = {
    eventId: input.eventId?.trim() || null,
    title: input.originalTitle.trim(),
    when: input.when,
    startIso: startIsoFromWhen(input.when),
    attendees: input.attendees,
    eventUrl: input.eventUrl,
    inviteBody,
    selfEmail: input.selfEmail?.trim().toLowerCase() || null,
  };
  const beforeMs = ctx.startIso ? Date.parse(ctx.startIso) : Date.now();
  const beforeIso = new Date(Math.min(beforeMs, Date.now() + 365 * 864e5)).toISOString();

  const pool = new EvidencePool();
  const connectors = new ConnectorTracker();
  const deps: GatherDeps = { mcp: input.mcpManager, pool, connectors };

  const description = inviteDescription(inviteBody);
  const inviteEvidenceId = pool.add({
    source: 'calendar',
    title: `Calendar invite: ${ctx.title || 'meeting'}`,
    excerpt: description || `Invite for "${ctx.title}" on ${ctx.when} (no description).`,
    url: ctx.eventUrl,
    tags: ['invite'],
  });

  const recurrence = detectRecurrence(inviteBody, ctx.eventId);
  const pastEvents = await searchPastCalendarEvents(deps, ctx.title, beforeIso);
  const sameTitle = filterSeriesInstances(pastEvents, {
    seriesId: null,
    title: ctx.title,
    currentEventId: ctx.eventId,
    beforeMs,
  });
  const classification = classifyMeeting({
    inviteBody,
    eventId: ctx.eventId,
    pastSameTitleCount: sameTitle.length,
  });

  let history: SeriesHistory | null = null;
  let parties: PartyProfile[] = [];

  if (classification.kind === 'recurring') {
    const seriesInstances = classification.seriesId
      ? filterSeriesInstances(pastEvents, {
          seriesId: classification.seriesId,
          title: ctx.title,
          currentEventId: ctx.eventId,
          beforeMs,
        })
      : [];
    history = await loadSeriesHistory({
      deps,
      meetingService: input.meetingService,
      title: ctx.title,
      seriesId: classification.seriesId,
      cadence: classification.cadence ?? recurrence.cadence,
      pastInstances: seriesInstances.length ? seriesInstances : sameTitle,
      beforeMs,
    });
    const lastStart = history.pastInstances[0]?.start;
    const sinceIso =
      lastStart && Number.isFinite(Date.parse(lastStart))
        ? new Date(Date.parse(lastStart)).toISOString()
        : new Date(Date.now() - RECURRING_DEFAULT_LOOKBACK_DAYS * 864e5).toISOString();
    await Promise.all([
      gatherActionEvidence({ deps, items: history.actionItems, sinceIso }),
      gatherMeetingContext({
        deps,
        ctx,
        meetingService: input.meetingService,
        sinceIso,
        includeLocalMeetings: false,
      }),
    ]);
  } else {
    const sinceIso = new Date(Date.now() - ONE_OFF_LOOKBACK_DAYS * 864e5).toISOString();
    const [profiles] = await Promise.all([
      researchParties({ deps, ctx }),
      gatherMeetingContext({
        deps,
        ctx,
        meetingService: input.meetingService,
        sinceIso,
        includeLocalMeetings: true,
      }),
    ]);
    parties = profiles;
  }

  const evidence = pool.list();
  const connectorList = connectors.snapshot();
  const perSource = evidence.reduce<Record<string, number>>((acc, e) => {
    acc[e.source] = (acc[e.source] || 0) + 1;
    return acc;
  }, {});
  log(
    `[Matter] Prep "${ctx.title}" (${classification.kind}): evidence ${JSON.stringify(perSource)}; connectors ${connectorList
      .map((c) => `${c.id}=${c.status}${c.reason ? `(${c.reason})` : ''}`)
      .join(' ')}`
  );
  const synthesized = input.config
    ? await synthesizePrepBrief({
        config: input.config,
        ctx,
        kind: classification.kind,
        evidence,
        history,
        parties,
      })
    : null;
  const brief =
    synthesized ||
    buildFallbackBrief({
      ctx,
      kind: classification.kind,
      evidence,
      history,
      parties,
      inviteEvidenceId,
    });

  const prepNote = renderPrepBrief({
    ctx,
    kind: classification.kind,
    cadence: history?.cadence ?? null,
    lastHeld: history?.lastHeld ?? null,
    actionItemsFrom: history?.actionItemsFrom ?? null,
    brief,
    evidence,
    connectors: connectorList,
  });

  const people = otherAttendees(ctx.attendees, ctx.selfEmail);
  const summary = [
    formatWhen(ctx.when, ctx.startIso),
    people.length
      ? `w/ ${people.slice(0, 3).map(displayName).join(', ')}${people.length > 3 ? ` +${people.length - 3}` : ''}`
      : '',
    brief.bottomLine,
  ]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 400);

  const openCount = brief.actionReview.filter((a) => a.status !== 'done').length;
  const suggestedAction = brief.agenda[0]
    ? `Lead with: ${brief.agenda[0].topic}${openCount ? ` (${openCount} action item${openCount === 1 ? '' : 's'} not confirmed done)` : ''}`
    : 'Review the prep note before joining.';

  return {
    kind: classification.kind,
    cadence: history?.cadence ?? null,
    lastHeld: history?.lastHeld ?? null,
    prepNote,
    summary,
    suggestedAction,
    brief,
    evidence,
    connectors: connectorList,
    usedFallback: !synthesized,
  };
}
