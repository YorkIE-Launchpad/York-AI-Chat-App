import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/os-notifications', () => ({
  showOsNotification: vi.fn(),
  focusAndNavigate: vi.fn(),
}));

import {
  notifyMatterBrief,
  notifyMatterItem,
  setMatterSlackAlerter,
} from '../../main/matter/matter-notifications';

describe('Matter Slack alerts', () => {
  afterEach(() => {
    setMatterSlackAlerter(null);
  });

  it('DMs opportunities via the GrowthOS bot alerter', () => {
    const slack = vi.fn();
    setMatterSlackAlerter(slack);
    notifyMatterItem({
      kind: 'opportunity',
      title: 'Acme upsell',
      body: 'Expansion signal in Hub notes',
    });
    expect(slack).toHaveBeenCalledWith(
      'Matter — opportunity: Acme upsell',
      'Expansion signal in Hub notes'
    );
  });

  it('does not Slack-DM ordinary Matter scan items', () => {
    const slack = vi.fn();
    setMatterSlackAlerter(slack);
    notifyMatterItem({
      kind: 'scan_critical',
      title: 'Unread ping',
      body: 'Needs reply',
    });
    expect(slack).not.toHaveBeenCalled();
  });

  it('Slack-DMs opportunity overflow briefs when alsoSlack is set', () => {
    const slack = vi.fn();
    setMatterSlackAlerter(slack);
    notifyMatterBrief({
      title: 'Matter — opportunities',
      body: '+3 more opportunities found.',
      alsoSlack: true,
    });
    expect(slack).toHaveBeenCalledWith('Matter — opportunities', '+3 more opportunities found.');
  });
});
