import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LoopsRuntimeConfig } from '../../shared/loops';
import type { DatabaseInstance } from '../../main/db/database';
import type { LoopRow } from '../../main/loops/loop-store';

const runtime = vi.hoisted(() => ({
  value: {
    captureFromMeetings: true,
    captureFromMatter: true,
    matterConfidenceThreshold: 0.7,
    screenedVersion: 0,
    capturePrompt: '',
    morningSlackDigestEnabled: true,
    morningDigestSentDay: '',
  },
}));

vi.mock('../../main/utils/logger', () => ({
  log: () => {},
  logWarn: () => {},
  logError: () => {},
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    getAll: () => ({ loopsRuntime: runtime.value }),
    update: (partial: { loopsRuntime: LoopsRuntimeConfig }) => {
      runtime.value = partial.loopsRuntime;
    },
  },
}));

import { LoopService } from '../../main/loops/loop-service';

function row(partial: Partial<LoopRow> & Pick<LoopRow, 'id' | 'title' | 'due_at'>): LoopRow {
  return {
    fingerprint: partial.id,
    notes: null,
    research_note: null,
    research_sources: null,
    research_status: 'idle',
    research_error: null,
    researched_at: null,
    origin: 'manual',
    source_ref: '{}',
    owner: 'me',
    counterpart: null,
    priority: 'normal',
    status: 'open',
    auto_captured: 0,
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    ...partial,
  };
}

function service(rows: LoopRow[]): LoopService {
  const db = {
    prepare: (sql: string) => ({
      all: () =>
        sql.includes("status = 'open'") ? rows.filter((item) => item.status === 'open') : [],
      run: () => {},
      get: () => undefined,
    }),
  } as unknown as DatabaseInstance;
  return new LoopService(db);
}

const MORNING = new Date(2026, 9, 16, 9, 0, 0, 0).getTime();

describe('LoopService morning Slack digest', () => {
  afterEach(() => {
    runtime.value = {
      captureFromMeetings: true,
      captureFromMatter: true,
      matterConfidenceThreshold: 0.7,
      screenedVersion: 0,
      capturePrompt: '',
      morningSlackDigestEnabled: true,
      morningDigestSentDay: '',
    };
  });

  it('DMs due follow-ups once per morning and retries when Slack is not ready', () => {
    const loops = service([
      row({ id: '1', title: 'Send the deck', due_at: MORNING - 86_400_000, counterpart: 'Ava' }),
    ]);
    const alert = vi.fn(() => false);
    loops.setSlackAlerter(alert);
    expect(loops.maybeSendMorningDigest(MORNING)).toBe(false);
    expect(runtime.value.morningDigestSentDay).toBe('');

    alert.mockReturnValue(true);
    expect(loops.maybeSendMorningDigest(MORNING)).toBe(true);
    expect(alert).toHaveBeenLastCalledWith(
      'Due follow-ups',
      '1 follow-up\n• Send the deck · Ava (overdue)'
    );
    expect(runtime.value.morningDigestSentDay).toBe('2026-10-16');
    expect(loops.maybeSendMorningDigest(MORNING)).toBe(false);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('stays quiet outside the morning window, when disabled, or when nothing is due', () => {
    const quiet = service([row({ id: '1', title: 'Later', due_at: MORNING + 10 * 86_400_000 })]);
    const alert = vi.fn(() => true);
    quiet.setSlackAlerter(alert);
    expect(quiet.maybeSendMorningDigest(new Date(2026, 9, 16, 7, 0).getTime())).toBe(false);
    expect(quiet.maybeSendMorningDigest(MORNING)).toBe(false);

    runtime.value = { ...runtime.value, morningSlackDigestEnabled: false };
    const overdue = service([row({ id: '2', title: 'Overdue', due_at: MORNING - 86_400_000 })]);
    overdue.setSlackAlerter(alert);
    expect(overdue.maybeSendMorningDigest(MORNING)).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
