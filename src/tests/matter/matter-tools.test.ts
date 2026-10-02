import { describe, expect, it, vi } from 'vitest';
import type { MatterItem, MatterMeeting, MatterSnapshot } from '../../shared/matter';
import { createMatterTools } from '../../main/matter/matter-tools';
import type { MatterService } from '../../main/matter/matter-service';

function item(partial: Partial<MatterItem> = {}): MatterItem {
  return {
    id: 'sig-1',
    fingerprint: 'fp',
    title: 'Ship the deck',
    summary: 'Client asked for the deck today.',
    whyItMatters: 'Review is this afternoon.',
    rawDetails: 'slack thread excerpt',
    severity: 'critical',
    orbit: 'now',
    category: 'delivery',
    source: 'slack',
    sourceRef: { url: 'https://slack.example/1' },
    confidence: 0.9,
    suggestedAction: 'Send the deck',
    status: 'active',
    pinned: false,
    snoozeUntil: null,
    dueAt: null,
    remindAt: null,
    expiresAt: null,
    reminderNotifiedAt: null,
    expiredNotifiedAt: null,
    rankScore: 90,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    resolvedAt: null,
    ...partial,
  };
}

function meeting(partial: Partial<MatterMeeting> = {}): MatterMeeting {
  return {
    id: 'mtg-1',
    fingerprint: 'mfp',
    eventId: 'evt-1',
    title: 'Acme weekly',
    when: 'Fri 10:00',
    startMs: 1_700_000_000_000,
    endMs: null,
    summary: 'Weekly check-in',
    htmlLink: null,
    rawDetails: '## Meeting prep\nBring the deck.',
    suggestedAction: null,
    updatedAt: 1,
    lastSeenAt: 1,
    ...partial,
  };
}

function snapshot(partial: Partial<MatterSnapshot> = {}): MatterSnapshot {
  return {
    items: [item()],
    meetings: [meeting()],
    meetingsLastFetch: null,
    meetingsFetching: false,
    lenses: [],
    focusScore: 82,
    criticalCount: 1,
    warningCount: 0,
    healthyCount: 0,
    pulse: 'One critical item.',
    lastScan: null,
    scanning: false,
    inScanWindow: true,
    connectorHealth: [],
    connectedCount: 0,
    muteRules: [],
    morningBrief: null,
    settings: {} as MatterSnapshot['settings'],
    profileSummary: null,
    ...partial,
  };
}

async function run(
  tool: ReturnType<typeof createMatterTools>[number],
  params: Record<string, unknown>
): Promise<string> {
  const result = await (
    tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>
  )('1', params);
  return result.content[0]?.text || '';
}

describe('matter tools', () => {
  it('lists and reads signals', async () => {
    const service = {
      getSnapshot: () => snapshot(),
    } as unknown as MatterService;
    const tools = createMatterTools(service);
    expect(tools.map((tool) => tool.name)).toEqual([
      'matter_list',
      'matter_read',
      'matter_meetings',
      'matter_meeting',
      'matter_prep',
      'matter_scan',
      'matter_act',
    ]);

    const listed = await run(tools[0], { orbit: 'now' });
    expect(listed).toContain('Ship the deck');
    expect(listed).toContain('sig-1');

    const empty = await run(tools[0], { orbit: 'week' });
    expect(empty).toContain('No active Matter signals');

    const read = await run(tools[1], { id: 'sig-1' });
    expect(read).toContain('slack thread excerpt');
  });

  it('reads a calendar meeting and runs prep', async () => {
    const prepMeeting = vi.fn(async () => snapshot());
    const service = {
      getSnapshot: () => snapshot(),
      prepMeeting,
    } as unknown as MatterService;
    const tools = createMatterTools(service);
    const listed = await run(tools[2], {});
    expect(listed).toContain('Acme weekly');
    const detail = await run(tools[3], { id: 'mtg-1' });
    expect(detail).toContain('Meeting prep');
    const prepped = await run(tools[4], { meetingId: 'mtg-1' });
    expect(prepMeeting).toHaveBeenCalledWith('mtg-1');
    expect(prepped).toContain('Bring the deck');
  });

  it('applies an action', async () => {
    const applyItemAction = vi.fn(() => snapshot({ items: [] }));
    const service = {
      getSnapshot: () => snapshot(),
      applyItemAction,
    } as unknown as MatterService;
    const tools = createMatterTools(service);
    const text = await run(tools[6], { itemId: 'sig-1', action: 'done' });
    expect(applyItemAction).toHaveBeenCalledWith({
      itemId: 'sig-1',
      action: 'done',
      snoozeUntil: undefined,
    });
    expect(text).toContain('no longer on the active radar');
  });
});
