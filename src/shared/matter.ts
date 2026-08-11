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

/** Stable marker for calendar prep notes stored in MatterItem.rawDetails. */
export const MEETING_PREP_MARKER = '## Meeting prep';

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

export interface MatterRuntimeConfig {
  enabled: boolean;
  windowStartHour: number;
  windowEndHour: number;
  intervalMinutes: number;
  sensitivity: MatterSensitivity;
  maxActiveItems: number;
  morningBriefEnabled: boolean;
  endOfDayWrapEnabled: boolean;
  autoOpenOnLaunch: boolean;
  sources: MatterSourcesConfig;
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
  sensitivity: 'balanced',
  maxActiveItems: 25,
  morningBriefEnabled: true,
  endOfDayWrapEnabled: false,
  autoOpenOnLaunch: false,
  sources: { ...DEFAULT_MATTER_SOURCES },
};

export interface MatterLens {
  id: MatterLensId;
  label: string;
  status: MatterLensStatus;
  summary: string;
  itemIds: string[];
  count: number;
}

export interface MatterConnectorHealth {
  id: string;
  name: string;
  connected: boolean;
  enabled: boolean;
}

export interface MatterSnapshot {
  items: MatterItem[];
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
