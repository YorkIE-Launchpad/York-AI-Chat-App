/**
 * Compact Matter snapshot for the macOS WidgetKit extension (App Group JSON).
 */

import {
  MEETING_PREP_MARKER,
  type MatterItem,
  type MatterSeverity,
  type MatterSnapshot,
} from './matter';
import {
  formatMeetingWhen,
  formatNextUpRelative,
  pickNextUpMeeting,
} from './matter-time';

export const MATTER_WIDGET_PAYLOAD_VERSION = 1;

export type MatterWidgetBriefKind = 'morning' | 'afternoon' | 'evening';

export interface MatterWidgetSignalRow {
  id: string;
  title: string;
  summary: string;
  severity: MatterSeverity;
}

export interface MatterWidgetNextMeeting {
  id: string;
  title: string;
  whenLine: string;
  relative: string;
  hasPrep: boolean;
}

export interface MatterWidgetPayload {
  version: number;
  updatedAt: number;
  matterEnabled: boolean;
  focusScore: number;
  criticalCount: number;
  warningCount: number;
  scanning: boolean;
  inScanWindow: boolean;
  briefKind: MatterWidgetBriefKind;
  briefText: string;
  nextMeeting: MatterWidgetNextMeeting | null;
  topSignals: MatterWidgetSignalRow[];
}

export function matterWidgetBriefKind(hour: number): MatterWidgetBriefKind {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** Top signals by severity (critical → warning → other), same order as welcome briefing. */
export function pickTopMatterItems(items: MatterItem[], limit = 3): MatterItem[] {
  const rank = (item: MatterItem) => {
    if (item.severity === 'critical') return 0;
    if (item.severity === 'warning') return 1;
    return 2;
  };
  return [...items].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

export function buildMatterWidgetPayload(
  snapshot: MatterSnapshot,
  now = Date.now()
): MatterWidgetPayload {
  const matterEnabled = snapshot.settings.enabled !== false;
  const hour = new Date(now).getHours();
  const briefKind = matterWidgetBriefKind(hour);

  if (!matterEnabled) {
    return {
      version: MATTER_WIDGET_PAYLOAD_VERSION,
      updatedAt: now,
      matterEnabled: false,
      focusScore: 0,
      criticalCount: 0,
      warningCount: 0,
      scanning: false,
      inScanWindow: false,
      briefKind,
      briefText: 'Matter is off. Open York GrowthOS to enable.',
      nextMeeting: null,
      topSignals: [],
    };
  }

  const briefText =
    snapshot.morningBrief?.trim() ||
    snapshot.pulse?.trim() ||
    (snapshot.scanning ? 'Scanning your connectors…' : 'Quiet for now.');

  const next = pickNextUpMeeting(snapshot.meetings || [], now);
  let nextMeeting: MatterWidgetNextMeeting | null = null;
  if (next) {
    const relative = formatNextUpRelative(next.startMs, next.endMs, now);
    nextMeeting = {
      id: next.id,
      title: next.title?.trim() || 'Untitled meeting',
      whenLine: formatMeetingWhen(next.startMs, next.endMs, next.when),
      relative,
      hasPrep: Boolean(next.rawDetails?.trim().startsWith(MEETING_PREP_MARKER)),
    };
  }

  const topSignals = pickTopMatterItems(snapshot.items).map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary || '',
    severity: item.severity,
  }));

  return {
    version: MATTER_WIDGET_PAYLOAD_VERSION,
    updatedAt: now,
    matterEnabled: true,
    focusScore: snapshot.focusScore,
    criticalCount: snapshot.criticalCount,
    warningCount: snapshot.warningCount,
    scanning: snapshot.scanning,
    inScanWindow: snapshot.inScanWindow,
    briefKind,
    briefText,
    nextMeeting,
    topSignals,
  };
}
