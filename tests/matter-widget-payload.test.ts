import { describe, expect, it } from 'vitest';
import {
  buildMatterWidgetPayload,
  MATTER_WIDGET_PAYLOAD_VERSION,
  matterWidgetBriefKind,
  pickTopMatterItems,
} from '../src/shared/matter-widget';
import { DEFAULT_MATTER_RUNTIME, type MatterItem, type MatterSnapshot } from '../src/shared/matter';
import { MEETING_PREP_MARKER } from '../src/shared/matter';

function baseSnapshot(overrides: Partial<MatterSnapshot> = {}): MatterSnapshot {
  return {
    items: [],
    meetings: [],
    meetingsLastFetch: null,
    meetingsFetching: false,
    lenses: [],
    focusScore: 88,
    criticalCount: 0,
    warningCount: 0,
    healthyCount: 0,
    pulse: 'All clear.',
    lastScan: null,
    scanning: false,
    inScanWindow: true,
    connectorHealth: [],
    connectedCount: 2,
    muteRules: [],
    morningBrief: null,
    settings: { ...DEFAULT_MATTER_RUNTIME, enabled: true },
    profileSummary: null,
    ...overrides,
  };
}

function item(partial: Partial<MatterItem> & Pick<MatterItem, 'id' | 'title'>): MatterItem {
  return {
    fingerprint: partial.id,
    summary: '',
    whyItMatters: '',
    rawDetails: null,
    severity: 'signal',
    orbit: 'today',
    category: 'comms',
    source: 'slack',
    sourceRef: {},
    confidence: 1,
    suggestedAction: null,
    status: 'active',
    pinned: false,
    snoozeUntil: null,
    dueAt: null,
    remindAt: null,
    expiresAt: null,
    reminderNotifiedAt: null,
    expiredNotifiedAt: null,
    rankScore: 50,
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: 0,
    resolvedAt: null,
    ...partial,
  };
}

describe('matterWidgetBriefKind', () => {
  it('maps hours to morning, afternoon, evening', () => {
    expect(matterWidgetBriefKind(8)).toBe('morning');
    expect(matterWidgetBriefKind(14)).toBe('afternoon');
    expect(matterWidgetBriefKind(20)).toBe('evening');
  });
});

describe('pickTopMatterItems', () => {
  it('orders critical before warning before signal', () => {
    const items = [
      item({ id: 'a', title: 'A', severity: 'signal' }),
      item({ id: 'b', title: 'B', severity: 'critical' }),
      item({ id: 'c', title: 'C', severity: 'warning' }),
    ];
    expect(pickTopMatterItems(items).map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('buildMatterWidgetPayload', () => {
  const noon = new Date('2026-06-15T12:00:00').getTime();

  it('returns disabled placeholder when Matter is off', () => {
    const payload = buildMatterWidgetPayload(
      baseSnapshot({ settings: { ...DEFAULT_MATTER_RUNTIME, enabled: false } }),
      noon
    );
    expect(payload.matterEnabled).toBe(false);
    expect(payload.topSignals).toEqual([]);
    expect(payload.version).toBe(MATTER_WIDGET_PAYLOAD_VERSION);
  });

  it('includes brief, meeting, and top signals', () => {
    const start = noon + 30 * 60 * 1000;
    const payload = buildMatterWidgetPayload(
      baseSnapshot({
        morningBrief: 'Ship the widget.',
        criticalCount: 1,
        warningCount: 2,
        items: [
          item({ id: 's1', title: 'Signal one', severity: 'critical', summary: 'Do it' }),
        ],
        meetings: [
          {
            id: 'm1',
            fingerprint: 'm1',
            eventId: 'ev1',
            title: 'Standup',
            when: '',
            startMs: start,
            endMs: start + 3600000,
            summary: '',
            htmlLink: null,
            rawDetails: `${MEETING_PREP_MARKER}\nnotes`,
            suggestedAction: null,
            updatedAt: 0,
            lastSeenAt: 0,
          },
        ],
      }),
      noon
    );
    expect(payload.briefText).toBe('Ship the widget.');
    expect(payload.briefKind).toBe('afternoon');
    expect(payload.nextMeeting?.title).toBe('Standup');
    expect(payload.nextMeeting?.hasPrep).toBe(true);
    expect(payload.topSignals).toHaveLength(1);
    expect(payload.topSignals[0].id).toBe('s1');
  });
});
