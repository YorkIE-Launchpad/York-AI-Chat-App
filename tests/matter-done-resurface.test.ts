import { describe, expect, it } from 'vitest';
import { matterContentKey, shouldKeepMatterScanSignal } from '../src/shared/matter';
import { nextMatterUpsertStatus } from '../src/main/matter/matter-store';
import {
  extractHubRequestId,
  hubRequestFingerprint,
  launchpadItemFingerprint,
} from '../src/main/matter/matter-collector';

describe('matterContentKey', () => {
  it('normalizes whitespace so trivial formatting churn matches', () => {
    expect(matterContentKey('  Hello\nworld  ', 'raw   body')).toBe(
      matterContentKey('Hello world', 'raw body')
    );
  });
});

describe('shouldKeepMatterScanSignal', () => {
  it('suppresses done fingerprints regardless of content', () => {
    expect(
      shouldKeepMatterScanSignal({
        existingStatus: 'done',
        existingSummary: 'Same',
        existingRawDetails: 'body',
        signalSummary: 'Same',
        signalRawDetails: 'body',
      })
    ).toBe(false);

    expect(
      shouldKeepMatterScanSignal({
        existingStatus: 'done',
        existingSummary: 'Old',
        existingRawDetails: 'old',
        signalSummary: 'Changed',
        signalRawDetails: 'new',
      })
    ).toBe(false);
  });

  it('suppresses dismissed when summary+rawDetails are unchanged', () => {
    expect(
      shouldKeepMatterScanSignal({
        existingStatus: 'dismissed',
        existingSummary: 'Pending review',
        existingRawDetails: 'details here',
        signalSummary: 'Pending review',
        signalRawDetails: 'details here',
      })
    ).toBe(false);
  });

  it('allows dismissed to resurface when raw details change', () => {
    expect(
      shouldKeepMatterScanSignal({
        existingStatus: 'dismissed',
        existingSummary: 'Pending review',
        existingRawDetails: 'details here',
        signalSummary: 'Pending review',
        signalRawDetails: 'details here — escalated',
      })
    ).toBe(true);
  });

  it('allows dismissed to resurface when summary changes', () => {
    expect(
      shouldKeepMatterScanSignal({
        existingStatus: 'dismissed',
        existingSummary: 'Pending review',
        existingRawDetails: 'details',
        signalSummary: 'Urgent review',
        signalRawDetails: 'details',
      })
    ).toBe(true);
  });

  it('keeps active / missing existing signals', () => {
    expect(
      shouldKeepMatterScanSignal({
        existingStatus: 'active',
        existingSummary: 'x',
        existingRawDetails: 'y',
        signalSummary: 'x',
        signalRawDetails: 'y',
      })
    ).toBe(true);
    expect(shouldKeepMatterScanSignal({})).toBe(true);
  });
});

describe('nextMatterUpsertStatus', () => {
  const now = Date.parse('2026-08-12T10:00:00.000Z');

  it('never promotes done to resurfaced', () => {
    expect(
      nextMatterUpsertStatus({
        existingStatus: 'done',
        incomingStatus: 'active',
        snoozeUntil: null,
        now,
      })
    ).toBe('done');
  });

  it('promotes dismissed to resurfaced when content re-enters ranking', () => {
    expect(
      nextMatterUpsertStatus({
        existingStatus: 'dismissed',
        incomingStatus: 'active',
        snoozeUntil: null,
        now,
      })
    ).toBe('resurfaced');
  });

  it('keeps snoozed while window is open', () => {
    expect(
      nextMatterUpsertStatus({
        existingStatus: 'snoozed',
        incomingStatus: 'active',
        snoozeUntil: now + 60_000,
        now,
      })
    ).toBe('snoozed');
  });
});

describe('hubRequestFingerprint', () => {
  it('prefers request id / uuid / #number over line hash', () => {
    expect(hubRequestFingerprint('Approve leave request #4821 for Ada')).toBe('hub:request:4821');
    expect(
      hubRequestFingerprint('Pending request id: abc-req-99 needs approval today')
    ).toBe('hub:request:abc-req-99');
    expect(
      hubRequestFingerprint('Follow up on 550e8400-e29b-41d4-a716-446655440000 please')
    ).toBe('hub:request:550e8400-e29b-41d4-a716-446655440000');
  });

  it('hashes normalized line when no id is present', () => {
    const a = hubRequestFingerprint('  Please approve equipment  request  ');
    const b = hubRequestFingerprint('Please approve equipment request');
    expect(a).toBe(b);
    expect(a.startsWith('hub:request:')).toBe(true);
    expect(extractHubRequestId('Please approve equipment request')).toBeNull();
  });
});

describe('launchpadItemFingerprint', () => {
  it('uses stable external id when present', () => {
    expect(
      launchpadItemFingerprint({
        stableName: 'Checkout redesign',
        raw: { id: 'rel-42', name: 'Checkout redesign', status: 'at_risk' },
      })
    ).toBe('launchpad:item:rel-42');
  });

  it('falls back to name hash without status or list index', () => {
    const risk = launchpadItemFingerprint({
      stableName: 'Checkout redesign',
      raw: { name: 'Checkout redesign', status: 'at_risk' },
    });
    const healthy = launchpadItemFingerprint({
      stableName: 'Checkout redesign',
      raw: { name: 'Checkout redesign', status: 'healthy' },
    });
    expect(risk).toBe(healthy);
    expect(risk).toBe('launchpad:item:' + risk.slice('launchpad:item:'.length));
    expect(risk.includes(':')).toBe(true);
    // No trailing :idx
    expect(risk.split(':')).toHaveLength(3);
  });

  it('keeps distinct names as distinct fingerprints', () => {
    const a = launchpadItemFingerprint({ stableName: 'Alpha', raw: { name: 'Alpha' } });
    const b = launchpadItemFingerprint({ stableName: 'Beta', raw: { name: 'Beta' } });
    expect(a).not.toBe(b);
  });
});
