/**
 * Shared Matter types — personal operational radar for York employees.
 */

export type MatterSeverity = 'critical' | 'warning' | 'healthy' | 'signal';
export type MatterOrbit = 'now' | 'today' | 'week' | 'watching';
export type MatterCategory = 'delivery' | 'people' | 'client' | 'comms' | 'time' | 'admin';
export type MatterSource =
  | 'jira'
  | 'slack'
  | 'gmail'
  | 'calendar'
  | 'hub'
  | 'meeting'
  | 'drive'
  | 'launchpad'
  | 'fused';
export type MatterItemStatus =
  | 'active'
  | 'snoozed'
  | 'done'
  | 'dismissed'
  | 'expired'
  | 'resurfaced';
export type MatterActionType =
  | 'done'
  | 'dismiss'
  | 'snooze'
  | 'pin'
  | 'unpin'
  | 'mute'
  | 'unmute'
  | 'open'
  | 'handle_chat';
export type MatterSensitivity = 'calm' | 'balanced' | 'hyper';
export type MatterLensId = 'delivery' | 'people' | 'clients' | 'comms' | 'time' | 'team';
export type MatterLensStatus = 'ACTIVE' | 'MONITORING' | 'CLEAR' | 'COORDINATING';

export const MATTER_LENS_IDS: readonly MatterLensId[] = [
  'delivery',
  'people',
  'clients',
  'comms',
  'time',
  'team',
] as const;

/** Categories that populate each focus lens. */
export const MATTER_LENS_CATEGORIES: Record<MatterLensId, readonly MatterCategory[]> = {
  delivery: ['delivery'],
  people: ['people'],
  clients: ['client'],
  comms: ['comms'],
  time: ['time'],
  team: ['people', 'admin'],
};

/** Primary lens for a signal category (`client` → `clients`, `admin` → `team`). */
export const MATTER_CATEGORY_PRIMARY_LENS: Record<MatterCategory, MatterLensId> = {
  delivery: 'delivery',
  people: 'people',
  client: 'clients',
  comms: 'comms',
  time: 'time',
  admin: 'team',
};

export const MATTER_SOURCE_IDS = [
  'calendar',
  'slack',
  'gmail',
  'jira',
  'hub',
  'meeting',
  'launchpad',
] as const;

/**
 * Default snooze window for Matter signals (and "clear Now" bulk snooze).
 * Long enough that the focus queue stays clear across a workday; not permanent.
 */
export const MATTER_DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;
export const MATTER_MIN_SNOOZE_MS = 60 * 60 * 1000;

/** Stable marker for calendar prep notes stored in MatterMeeting.rawDetails. */
export const MEETING_PREP_MARKER = '## Meeting prep';

export type MeetingPrepKind = 'recurring' | 'one_off';

/** Labels written into the prep note header; `meetingPrepKind` parses them back. */
export const MEETING_PREP_KIND_LABELS: Record<MeetingPrepKind, string> = {
  recurring: 'Recurring',
  one_off: 'One-off',
};

/** Meeting kind from a prep note header line (`**Title** · when · Recurring (weekly) · …`). */
export function meetingPrepKind(rawDetails: string | null | undefined): MeetingPrepKind | null {
  const text = rawDetails?.trim();
  if (!text?.startsWith(MEETING_PREP_MARKER)) return null;
  const header = text
    .slice(MEETING_PREP_MARKER.length)
    .split('\n')
    .find((line) => line.trim());
  if (!header) return null;
  if (/·\s*Recurring\b/.test(header)) return 'recurring';
  if (/·\s*One-off\b/.test(header)) return 'one_off';
  return null;
}

/** Dedicated meetings list poll — independent of Matter signal `intervalMinutes`. */
export const DEFAULT_MATTER_MEETINGS_INTERVAL_MINUTES = 15;

export type MatterConfigurableSource = (typeof MATTER_SOURCE_IDS)[number];

export interface MatterSourceRef {
  connectorId?: string | null;
  toolName?: string | null;
  externalId?: string | null;
  url?: string | null;
  label?: string | null;
}

export interface MatterItem {
  id: string;
  fingerprint: string;
  title: string;
  summary: string;
  whyItMatters: string;
  /** Exact connector payload excerpt used to form this item. */
  rawDetails: string | null;
  severity: MatterSeverity;
  orbit: MatterOrbit;
  category: MatterCategory;
  source: MatterSource;
  sourceRef: MatterSourceRef;
  confidence: number;
  suggestedAction: string | null;
  status: MatterItemStatus;
  pinned: boolean;
  snoozeUntil: number | null;
  /** When the action is due (e.g. meeting start). */
  dueAt: number | null;
  /** When to fire the pre-due OS reminder. */
  remindAt: number | null;
  expiresAt: number | null;
  /** Set after the reminder OS notification was shown (dedupe). */
  reminderNotifiedAt: number | null;
  /** Set after the expiry OS notification was shown (dedupe). */
  expiredNotifiedAt: number | null;
  rankScore: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
}

export interface MatterAction {
  id: string;
  itemId: string | null;
  fingerprint: string | null;
  action: MatterActionType;
  muteKey: string | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export interface MatterScan {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: 'running' | 'success' | 'error' | 'skipped';
  sourcesChecked: string[];
  sourcesSkipped: string[];
  itemCount: number;
  criticalCount: number;
  warningCount: number;
  error: string | null;
  brief: string | null;
}

export interface MatterMuteRule {
  key: string;
  kind: 'fingerprint' | 'sender' | 'project' | 'category' | 'thread';
  label: string;
  createdAt: number;
}

export interface MatterSourcesConfig {
  calendar: boolean;
  slack: boolean;
  gmail: boolean;
  jira: boolean;
  hub: boolean;
  meeting: boolean;
  launchpad: boolean;
}

export type MatterSourcePrompts = Record<MatterConfigurableSource, string>;

export const MATTER_SOURCE_PROMPT_MAX_CHARS = 2000;

export const DEFAULT_MATTER_SOURCE_PROMPTS: MatterSourcePrompts = {
  calendar: '',
  slack: '',
  gmail: '',
  jira: '',
  hub: '',
  meeting: '',
  launchpad: '',
};

/**
 * Opportunities — things the user can do for the company, detected from Matter scans.
 * Platform issues are reported to the owning team; sales openings to the service-line owner.
 */
export type OpportunityKind = 'platform_issue' | 'cross_sell' | 'upsell';
export type OpportunityStatus = 'new' | 'reported' | 'dismissed' | 'snoozed';

export const OPPORTUNITY_PLATFORM_TARGETS = [
  'hub',
  'rd_launchpad',
  'gtm_launchpad',
  'rd_pulse',
  'gtm_pulse',
] as const;

export const OPPORTUNITY_SERVICE_TARGETS = [
  'rnd_services',
  'gtm_services',
  'marketing',
  'finops',
  'investment',
] as const;

export type OpportunityPlatformTarget = (typeof OPPORTUNITY_PLATFORM_TARGETS)[number];
export type OpportunityServiceTarget = (typeof OPPORTUNITY_SERVICE_TARGETS)[number];
export type OpportunityTarget = OpportunityPlatformTarget | OpportunityServiceTarget;

export const OPPORTUNITY_TARGETS: readonly OpportunityTarget[] = [
  ...OPPORTUNITY_PLATFORM_TARGETS,
  ...OPPORTUNITY_SERVICE_TARGETS,
];

export const OPPORTUNITY_TARGET_LABELS: Record<OpportunityTarget, string> = {
  hub: 'Hub',
  rd_launchpad: 'R&D Launchpad',
  gtm_launchpad: 'GTM Launchpad',
  rd_pulse: 'R&D Pulse',
  gtm_pulse: 'GTM Pulse',
  rnd_services: 'R&D / Software Development',
  gtm_services: 'GTM / Revenue Operations',
  marketing: 'Digital Marketing',
  finops: 'Financial Operations',
  investment: 'Investment / Advisory',
};

export interface YorkServiceLine {
  id: OpportunityServiceTarget;
  label: string;
  description: string;
  buyingSignals: string[];
}

/** York IE service lines (york.ie) — used by the detector prompt and the UI. */
export const YORK_SERVICE_CATALOG: readonly YorkServiceLine[] = [
  {
    id: 'rnd_services',
    label: OPPORTUNITY_TARGET_LABELS.rnd_services,
    description:
      'Product R&D and software development: MVPs, platform builds, AI features, QA, DevOps, dedicated engineering pods.',
    buyingSignals: [
      'hiring engineers or struggling to hire',
      'missed launch or slipping roadmap',
      'tech debt, outages, scaling or performance pain',
      'wants to build an AI / data feature',
      'needs a new app, integration or rebuild',
    ],
  },
  {
    id: 'gtm_services',
    label: OPPORTUNITY_TARGET_LABELS.gtm_services,
    description:
      'Go-to-market and revenue operations: GTM strategy, sales process, CRM / HubSpot / Salesforce ops, pipeline and outbound.',
    buyingSignals: [
      'pipeline dropping or missing revenue targets',
      'launching into a new market or segment',
      'CRM mess, bad forecasting or reporting',
      'needs SDRs, outbound or sales playbooks',
    ],
  },
  {
    id: 'marketing',
    label: OPPORTUNITY_TARGET_LABELS.marketing,
    description:
      'Digital marketing: content, SEO, paid media, brand, website, demand generation and campaigns.',
    buyingSignals: [
      'low inbound or website traffic',
      'rebrand, new website or product launch campaign',
      'needs content, social or paid ads help',
    ],
  },
  {
    id: 'finops',
    label: OPPORTUNITY_TARGET_LABELS.finops,
    description:
      'Financial operations: bookkeeping, monthly close, FP&A, budgeting, investor reporting, fundraising readiness.',
    buyingSignals: [
      'books or monthly close behind',
      'needs a financial model, budget or board pack',
      'preparing for fundraise or due diligence',
      'cash-flow or burn concerns',
    ],
  },
  {
    id: 'investment',
    label: OPPORTUNITY_TARGET_LABELS.investment,
    description:
      'Investment and tech-enabled advisory for startups: capital, strategic advisory, fractional leadership.',
    buyingSignals: [
      'raising a round or looking for investors',
      'needs fractional CTO / CRO / CFO or strategic advice',
      'considering M&A, partnership or expansion',
    ],
  },
];

export function isOpportunityPlatformTarget(
  target: OpportunityTarget
): target is OpportunityPlatformTarget {
  return (OPPORTUNITY_PLATFORM_TARGETS as readonly string[]).includes(target);
}

export interface MatterOpportunity {
  id: string;
  fingerprint: string;
  kind: OpportunityKind;
  target: OpportunityTarget;
  title: string;
  summary: string;
  /** Quoted excerpt from the source that supports this opportunity. */
  evidence: string;
  source: MatterSource;
  sourceRef: MatterSourceRef;
  clientName: string | null;
  /** Sales only — how to open the conversation. */
  suggestedPitch: string | null;
  confidence: number;
  status: OpportunityStatus;
  snoozeUntil: number | null;
  reportedAt: number | null;
  /** Slack channel / user the report was posted to. */
  reportedTo: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OpportunityRoute {
  slackChannel?: string;
  slackUserId?: string;
}

export interface MatterOpportunitiesConfig {
  enabled: boolean;
  /** Opportunities below this confidence (0–1) are hidden and never notify. */
  minConfidence: number;
  notify: boolean;
  routing: Record<OpportunityTarget, OpportunityRoute>;
}

export const DEFAULT_OPPORTUNITY_ROUTING: Record<OpportunityTarget, OpportunityRoute> =
  Object.fromEntries(OPPORTUNITY_TARGETS.map((t) => [t, {}])) as Record<
    OpportunityTarget,
    OpportunityRoute
  >;

export const DEFAULT_MATTER_OPPORTUNITIES: MatterOpportunitiesConfig = {
  enabled: true,
  minConfidence: 0.6,
  notify: true,
  routing: { ...DEFAULT_OPPORTUNITY_ROUTING },
};

/** Slack destination for an opportunity target (channel wins over user DM). */
export function opportunityDestination(
  routing: Record<OpportunityTarget, OpportunityRoute>,
  target: OpportunityTarget
): string | null {
  const route = routing[target] || {};
  return route.slackChannel?.trim() || route.slackUserId?.trim() || null;
}

export interface OpportunityReportPreview {
  opportunityId: string;
  channel: string | null;
  text: string;
}

export interface OpportunityReportInput {
  opportunityId: string;
  channel: string;
  text: string;
}

export interface OpportunityActionInput {
  opportunityId: string;
  action: 'dismiss' | 'snooze';
  snoozeUntil?: number | null;
}

export interface MatterRuntimeConfig {
  enabled: boolean;
  windowStartHour: number;
  windowEndHour: number;
  /** Signal radar scan interval (minutes). */
  intervalMinutes: number;
  /**
   * Calendar meetings list refresh interval (minutes).
   * Independent of signal scans — default 15.
   */
  meetingsIntervalMinutes: number;
  sensitivity: MatterSensitivity;
  /** Signals with confidence below this (0–1) are hidden and never notify. Pinned are exempt. */
  minConfidence: number;
  maxActiveItems: number;
  morningBriefEnabled: boolean;
  endOfDayWrapEnabled: boolean;
  autoOpenOnLaunch: boolean;
  sources: MatterSourcesConfig;
  sourcePrompts: MatterSourcePrompts;
  opportunities: MatterOpportunitiesConfig;
}

export const DEFAULT_MATTER_SOURCES: MatterSourcesConfig = {
  calendar: true,
  slack: true,
  gmail: true,
  jira: true,
  hub: true,
  meeting: true,
  launchpad: true,
};

export const DEFAULT_MATTER_RUNTIME: MatterRuntimeConfig = {
  enabled: true,
  windowStartHour: 8,
  windowEndHour: 21,
  intervalMinutes: 60,
  meetingsIntervalMinutes: DEFAULT_MATTER_MEETINGS_INTERVAL_MINUTES,
  sensitivity: 'balanced',
  minConfidence: 0,
  maxActiveItems: 50,
  morningBriefEnabled: true,
  endOfDayWrapEnabled: false,
  autoOpenOnLaunch: false,
  sources: { ...DEFAULT_MATTER_SOURCES },
  sourcePrompts: { ...DEFAULT_MATTER_SOURCE_PROMPTS },
  opportunities: { ...DEFAULT_MATTER_OPPORTUNITIES, routing: { ...DEFAULT_OPPORTUNITY_ROUTING } },
};

/**
 * Upcoming Google Calendar meetings on the Matter page — peer to Signals, not radar items.
 */
export interface MatterMeeting {
  id: string;
  fingerprint: string;
  eventId: string;
  title: string;
  when: string;
  startMs: number | null;
  endMs: number | null;
  summary: string;
  htmlLink: string | null;
  /** Invite excerpt and/or `## Meeting prep` note after Prep. */
  rawDetails: string | null;
  suggestedAction: string | null;
  updatedAt: number;
  lastSeenAt: number;
}

/** Normalize text for Matter content equality (dismiss change detection). */
export function normalizeMatterContentText(text: string | null | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Stable key for Matter content equality.
 * Done and dismissed items never auto-resurface from this key.
 */
export function matterContentKey(
  summary: string | null | undefined,
  rawDetails: string | null | undefined
): string {
  return `${normalizeMatterContentText(summary)}\n${normalizeMatterContentText(rawDetails)}`;
}

/**
 * Whether a collected signal should proceed past done/dismiss gates on a scan.
 * Done and dismissed stay suppressed, including when the wording changes.
 */
export function shouldKeepMatterScanSignal(input: {
  existingStatus?: MatterItemStatus | null;
  existingSummary?: string | null;
  existingRawDetails?: string | null;
  signalSummary?: string | null;
  signalRawDetails?: string | null;
}): boolean {
  if (input.existingStatus === 'done' || input.existingStatus === 'dismissed') return false;
  return true;
}

/** Whether a signal clears the user's confidence threshold. Pinned signals always pass. */
export function meetsMatterConfidence(
  item: Pick<MatterItem, 'confidence' | 'pinned'>,
  minConfidence: number
): boolean {
  if (item.pinned || minConfidence <= 0) return true;
  return item.confidence >= minConfidence;
}

export interface MatterLens {
  id: MatterLensId;
  label: string;
  status: MatterLensStatus;
  summary: string;
  itemIds: string[];
  count: number;
}

/** Focus lens to passively highlight when a signal is selected (does not filter). */
export function relatedMatterLensId(
  item: Pick<MatterItem, 'id' | 'category'> | null | undefined,
  lenses: MatterLens[] = []
): MatterLensId | null {
  if (!item) return null;
  const primary = MATTER_CATEGORY_PRIMARY_LENS[item.category];
  if (primary) return primary;
  return lenses.find((lens) => lens.itemIds.includes(item.id))?.id ?? null;
}

export interface MatterConnectorHealth {
  id: string;
  name: string;
  connected: boolean;
  enabled: boolean;
}

export interface MatterSnapshot {
  items: MatterItem[];
  /** Upcoming calendar meetings (not signals). */
  meetings: MatterMeeting[];
  meetingsLastFetch: number | null;
  meetingsFetching: boolean;
  lenses: MatterLens[];
  focusScore: number;
  criticalCount: number;
  warningCount: number;
  healthyCount: number;
  pulse: string;
  lastScan: MatterScan | null;
  scanning: boolean;
  inScanWindow: boolean;
  connectorHealth: MatterConnectorHealth[];
  connectedCount: number;
  muteRules: MatterMuteRule[];
  morningBrief: string | null;
  settings: MatterRuntimeConfig;
  profileSummary: string | null;
  /** Open opportunities (new status, above threshold), newest first. */
  opportunities: MatterOpportunity[];
}

export interface MatterItemActionInput {
  itemId: string;
  action: 'done' | 'dismiss' | 'snooze' | 'pin' | 'unpin' | 'open';
  snoozeUntil?: number | null;
  mute?: {
    kind: MatterMuteRule['kind'];
    key: string;
    label: string;
  } | null;
}

export interface MatterAskPayload {
  prompt: string;
  itemIds?: string[];
}
