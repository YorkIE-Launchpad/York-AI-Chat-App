/**
 * Matter Opportunities — detects things the user can do for the company from scan data:
 * internal platform issues (report to the owning team) and cross-sell / upsell openings
 * (report to the service-line owner). Never acts on its own; reporting is user-confirmed.
 */

import { createHash } from 'crypto';
import type { AppConfig } from '../config/config-store';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import {
  OPPORTUNITY_PLATFORM_TARGETS,
  OPPORTUNITY_TARGETS,
  OPPORTUNITY_TARGET_LABELS,
  YORK_SERVICE_CATALOG,
  type MatterOpportunity,
  type MatterSource,
  type MatterSourceRef,
  type OpportunityKind,
  type OpportunityTarget,
} from '../../shared/matter';
import {
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../shared/mcp-defaults';
import { log, logWarn } from '../utils/logger';
import {
  envelopeBody,
  findToolName,
  isServerConnected,
  parseJsonLoose,
  parseSlackSearchBody,
  resolveHubServerId,
  safeCallTool,
  slackMessageWithinLookback,
  type RawMatterSignal,
} from './matter-collector';
import { extractJsonObject, matterOneShotConfig } from './matter-ranker';
import type { OpportunityDraft } from './matter-store';

const MAX_CONTEXT_ITEMS = 40;
const MAX_ITEM_CHARS = 1200;
const MAX_TRANSCRIPT_CHARS = 3000;
const MAX_OPPORTUNITIES_PER_SCAN = 8;
const SLACK_SEARCH_LIMIT = 15;
const MAX_GMAIL_THREADS = 8;
const MAX_MEETINGS = 6;

const PLATFORM_SEARCH_TERMS = ['Hub', 'Launchpad', 'Pulse', 'GTM Launchpad', 'R&D Launchpad'];
const ISSUE_TERMS = ['bug', 'broken', 'issue', 'not working', 'error', 'crash', 'fails'];
const SALES_TERMS = [
  'budget',
  'proposal',
  'hiring',
  'fundraise',
  'pipeline',
  'marketing',
  'website',
  'roadmap',
  'scale',
  'extend',
  'expand',
];

export interface OpportunityContextItem {
  ref: string;
  source: MatterSource;
  title: string;
  text: string;
  sourceRef: MatterSourceRef;
}

export interface OpportunityContext {
  items: OpportunityContextItem[];
  /** Hub client / project roster (names + services), used to tell cross-sell from upsell. */
  clientRoster: string | null;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function hashKey(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function fromRawSignal(signal: RawMatterSignal): OpportunityContextItem {
  return {
    ref: signal.fingerprint,
    source: signal.source,
    title: signal.title,
    text: clip(signal.rawDetails || signal.rawExcerpt || signal.summary, MAX_ITEM_CHARS),
    sourceRef: signal.sourceRef || {},
  };
}

async function collectSlackMentions(mcpManager: MCPManager): Promise<OpportunityContextItem[]> {
  if (!isServerConnected(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID)) return [];
  const tool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
    'search_messages',
    'search_public_and_private',
    'search_public',
  ]);
  if (!tool) return [];
  const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const platformQuery = `(${PLATFORM_SEARCH_TERMS.map((t) => `"${t}"`).join(' OR ')}) (${ISSUE_TERMS.join(' OR ')}) after:${after}`;
  const salesQuery = `(${SALES_TERMS.join(' OR ')}) client after:${after}`;
  const out: OpportunityContextItem[] = [];
  const seen = new Set<string>();
  for (const query of [platformQuery, salesQuery]) {
    const text = await safeCallTool(mcpManager, tool, {
      query,
      limit: SLACK_SEARCH_LIMIT,
      sort: 'timestamp',
    });
    if (!text) continue;
    for (const msg of parseSlackSearchBody(envelopeBody(text))) {
      const key = `${msg.channel}:${msg.ts}`;
      if (seen.has(key) || !slackMessageWithinLookback(msg.ts)) continue;
      seen.add(key);
      out.push({
        ref: `slack:msg:${key}`,
        source: 'slack',
        title: `${msg.user || 'Someone'} in ${msg.channelLabel || msg.channel}`,
        text: clip(msg.text, MAX_ITEM_CHARS),
        sourceRef: {
          connectorId: DEFAULT_SLACK_MCP_SERVER_ID,
          externalId: key,
          label: 'Slack',
          url: msg.link,
        },
      });
    }
  }
  return out;
}

async function collectClientEmails(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<OpportunityContextItem[]> {
  if (!isServerConnected(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID)) return [];
  const searchTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
    'search_emails',
    'list_messages',
  ]);
  if (!searchTool) return [];
  const ownDomain = profile?.email?.split('@')[1];
  const query = [
    'newer_than:7d',
    ownDomain ? `-from:${ownDomain}` : '',
    '-category:promotions -category:social -category:updates',
  ]
    .filter(Boolean)
    .join(' ');
  const searchText = await safeCallTool(mcpManager, searchTool, {
    query,
    limit: MAX_GMAIL_THREADS,
  });
  if (!searchText) return [];

  const ids = envelopeBody(searchText)
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z0-9_-]{6,}$/.test(l));
  if (!ids.length) {
    const parsed = parseJsonLoose(searchText);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'string') ids.push(item);
        else if (item && typeof item === 'object' && 'id' in item) {
          ids.push(String((item as { id: unknown }).id));
        }
      }
    }
  }

  const getTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
    'get_email',
    'get_message',
  ]);
  if (!getTool) return [];

  const out: OpportunityContextItem[] = [];
  for (const id of ids.slice(0, MAX_GMAIL_THREADS)) {
    const detail = await safeCallTool(mcpManager, getTool, { message_id: id });
    if (!detail) continue;
    const parsed = parseJsonLoose(detail);
    const env = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const subject = typeof env?.title === 'string' && env.title.trim() ? env.title.trim() : 'Email';
    const body = typeof env?.body === 'string' ? env.body : detail;
    out.push({
      ref: `gmail:msg:${id}`,
      source: 'gmail',
      title: subject,
      text: clip(body, MAX_ITEM_CHARS),
      sourceRef: {
        connectorId: DEFAULT_GMAIL_MCP_SERVER_ID,
        externalId: id,
        label: 'Gmail',
        url: `https://mail.google.com/mail/u/0/#all/${id}`,
      },
    });
  }
  return out;
}

function collectMeetingNotes(meetingService: MeetingService | null): OpportunityContextItem[] {
  if (!meetingService) return [];
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const out: OpportunityContextItem[] = [];
  try {
    for (const item of meetingService.list().slice(0, MAX_MEETINGS * 2)) {
      if (item.startedAt < cutoff) continue;
      const meeting = meetingService.get(item.id);
      if (!meeting) continue;
      const parts = [
        meeting.notes?.summary && `Summary: ${meeting.notes.summary}`,
        meeting.notes?.keyTopics?.length && `Topics: ${meeting.notes.keyTopics.join('; ')}`,
        meeting.notes?.actionItems?.length &&
          `Action items: ${meeting.notes.actionItems.join('; ')}`,
        meeting.transcriptText &&
          `Transcript excerpt: ${clip(meeting.transcriptText, MAX_TRANSCRIPT_CHARS)}`,
      ].filter(Boolean) as string[];
      if (!parts.length) continue;
      out.push({
        ref: `meeting:${meeting.id}`,
        source: 'meeting',
        title: meeting.notes?.title || meeting.title || 'Meeting',
        text: clip(parts.join('\n'), MAX_TRANSCRIPT_CHARS + MAX_ITEM_CHARS),
        sourceRef: { externalId: meeting.id, label: meeting.title || 'Meeting' },
      });
      if (out.length >= MAX_MEETINGS) break;
    }
  } catch (error) {
    logWarn('[Matter] Opportunity meeting context failed:', error);
  }
  return out;
}

async function collectClientRoster(mcpManager: MCPManager): Promise<string | null> {
  const hubId = resolveHubServerId(mcpManager);
  if (!hubId || !isServerConnected(mcpManager, hubId)) return null;
  const parts: string[] = [];
  const clientsTool = findToolName(mcpManager, hubId, ['list_clients']);
  if (clientsTool) {
    const text = await safeCallTool(mcpManager, clientsTool, {});
    if (text) parts.push(`Clients:\n${clip(envelopeBody(text), 3000)}`);
  }
  const projectsTool = findToolName(mcpManager, hubId, ['list_project_summaries', 'list_projects']);
  if (projectsTool) {
    const text = await safeCallTool(mcpManager, projectsTool, {});
    if (text) parts.push(`Projects (client + service):\n${clip(envelopeBody(text), 4000)}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

/**
 * Broader second pass than the action-only Matter collectors: platform complaints,
 * external email, recent meeting notes / transcripts, and the Hub client roster.
 */
export async function collectOpportunityContext(options: {
  mcpManager: MCPManager | null;
  meetingService: MeetingService | null;
  profile: WelcomeProfile | null;
  scanSignals: RawMatterSignal[];
}): Promise<OpportunityContext> {
  const { mcpManager, meetingService, profile, scanSignals } = options;
  const [slack, gmail, roster] = mcpManager
    ? await Promise.all([
        collectSlackMentions(mcpManager).catch(() => []),
        collectClientEmails(mcpManager, profile).catch(() => []),
        collectClientRoster(mcpManager).catch(() => null),
      ])
    : [[], [], null];
  const meetings = collectMeetingNotes(meetingService);

  const seen = new Set<string>();
  const items: OpportunityContextItem[] = [];
  for (const item of [
    ...meetings,
    ...slack,
    ...gmail,
    ...scanSignals.filter((s) => s.source !== 'calendar').map(fromRawSignal),
  ]) {
    if (seen.has(item.ref)) continue;
    seen.add(item.ref);
    items.push(item);
    if (items.length >= MAX_CONTEXT_ITEMS) break;
  }
  return { items, clientRoster: roster };
}

function buildSystemPrompt(): string {
  const services = YORK_SERVICE_CATALOG.map(
    (s) => `- ${s.id} (${s.label}): ${s.description} Buying signals: ${s.buyingSignals.join('; ')}.`
  ).join('\n');
  const platforms = OPPORTUNITY_PLATFORM_TARGETS.map(
    (id) => `- ${id} (${OPPORTUNITY_TARGET_LABELS[id]})`
  ).join('\n');
  return `You are Matter Opportunity Scout for York IE — an investment firm doing tech-enabled advisory for startups.
Find things this employee can do FOR THE COMPANY, from the work context provided. Two kinds only:

1. platform_issue — a concrete bug, outage, complaint, or missing capability in one of York's INTERNAL platforms:
${platforms}
   Target = the platform id. Report so the owning team can fix it.

2. cross_sell / upsell — a client or prospect expresses a need York IE can sell:
${services}
   cross_sell = the client does not already buy that service line (per the client roster, if given).
   upsell = the client already buys that service line and needs more of it (scope, seats, retainer, phase 2).
   Target = the service line id. Include clientName and a one-sentence suggestedPitch.

Rules:
- Every opportunity MUST cite one input ref and quote a short evidence excerpt (verbatim, <= 240 chars) from that item.
- Skip vague chatter, internal banter, already-resolved issues, and generic newsletters.
- Never invent clients, people, or needs not in the input. If unsure of the client, set clientName null.
- At most ${MAX_OPPORTUNITIES_PER_SCAN} opportunities; fewer is fine; none is fine.
- confidence 0–1: how clearly the evidence supports the opportunity.

Return ONLY valid JSON:
{"opportunities":[{"ref":"<input ref>","kind":"platform_issue|cross_sell|upsell","target":"<id>","title":"<= 90 chars","summary":"1-2 sentences","evidence":"quoted excerpt","clientName":null,"suggestedPitch":null,"confidence":0.0}]}`;
}

function asKind(v: unknown): OpportunityKind | null {
  return v === 'platform_issue' || v === 'cross_sell' || v === 'upsell' ? v : null;
}

function asTarget(v: unknown): OpportunityTarget | null {
  return typeof v === 'string' && (OPPORTUNITY_TARGETS as readonly string[]).includes(v)
    ? (v as OpportunityTarget)
    : null;
}

function asText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function parseOpportunityResponse(
  parsed: unknown,
  context: OpportunityContext
): OpportunityDraft[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { opportunities?: unknown }).opportunities;
  if (!Array.isArray(list)) return [];
  const byRef = new Map(context.items.map((i) => [i.ref, i]));
  const out: OpportunityDraft[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const kind = asKind(raw.kind);
    const target = asTarget(raw.target);
    const item = typeof raw.ref === 'string' ? byRef.get(raw.ref) : undefined;
    const title = asText(raw.title, 140);
    if (!kind || !target || !item || !title) continue;
    const isPlatformTarget = (OPPORTUNITY_PLATFORM_TARGETS as readonly string[]).includes(target);
    if ((kind === 'platform_issue') !== isPlatformTarget) continue;
    const fingerprint = `opp:${kind}:${target}:${hashKey(item.ref)}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.5;
    out.push({
      fingerprint,
      kind,
      target,
      title,
      summary: asText(raw.summary, 500),
      evidence: asText(raw.evidence, 400) || item.text.slice(0, 240),
      source: item.source,
      sourceRef: item.sourceRef,
      clientName: kind === 'platform_issue' ? null : asText(raw.clientName, 120) || null,
      suggestedPitch: kind === 'platform_issue' ? null : asText(raw.suggestedPitch, 400) || null,
      confidence,
    });
    if (out.length >= MAX_OPPORTUNITIES_PER_SCAN) break;
  }
  return out;
}

export async function detectOpportunities(options: {
  config: AppConfig;
  profile: WelcomeProfile | null;
  context: OpportunityContext;
}): Promise<OpportunityDraft[]> {
  const { config, profile, context } = options;
  if (context.items.length === 0) return [];
  try {
    const userPrompt = JSON.stringify({
      employee: profile
        ? { name: profile.name, title: profile.title, function: profile.functionName }
        : null,
      clientRoster: context.clientRoster,
      items: context.items.map((i) => ({
        ref: i.ref,
        source: i.source,
        title: i.title,
        text: i.text,
      })),
    });
    const result = await runPiAiOneShot(
      userPrompt,
      buildSystemPrompt(),
      matterOneShotConfig(config),
      { usageFeature: 'matter_opportunities', usageSessionId: 'matter_opportunities' }
    );
    const drafts = parseOpportunityResponse(extractJsonObject(result.text), context);
    log(`[Matter] Opportunities detected: ${drafts.length} from ${context.items.length} items`);
    return drafts;
  } catch (error) {
    logWarn('[Matter] Opportunity detection failed:', error);
    return [];
  }
}

const KIND_LABELS: Record<OpportunityKind, string> = {
  platform_issue: 'Platform issue',
  cross_sell: 'Cross-sell opportunity',
  upsell: 'Upsell opportunity',
};

/** Slack message body for reporting an opportunity to its owning team. */
export function buildOpportunityReport(
  opp: MatterOpportunity,
  reporterName?: string | null
): string {
  const lines = [
    `*${KIND_LABELS[opp.kind]} — ${OPPORTUNITY_TARGET_LABELS[opp.target]}*`,
    `*${opp.title}*`,
  ];
  if (opp.clientName) lines.push(`Client: ${opp.clientName}`);
  if (opp.summary) lines.push(opp.summary);
  if (opp.evidence) lines.push(`> ${opp.evidence.replace(/\n+/g, ' ')}`);
  const link = opp.sourceRef.url;
  const label = opp.sourceRef.label || opp.source;
  lines.push(link ? `Source: <${link}|${label}>` : `Source: ${label}`);
  if (opp.suggestedPitch) lines.push(`Suggested opener: ${opp.suggestedPitch}`);
  lines.push(`_Reported by ${reporterName || 'a teammate'} via Matter_`);
  return lines.join('\n');
}
