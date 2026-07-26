import { describe, expect, it } from 'vitest';
import {
  extractHubProfileFields,
  mergeHubProfileFields,
} from '../../main/welcome/extract-hub-profile';
import {
  enrichChipsWithConnectorNames,
  getStaticFallbackChips,
  parseAndValidateWelcomeChips,
} from '../../main/welcome/generate-welcome-actions';
import {
  buildConnectorFingerprint,
  formatWelcomeProfileSummary,
  isWelcomeActionIcon,
  type WelcomeConnectorSnapshot,
} from '../../shared/welcome-actions';

const connectors: WelcomeConnectorSnapshot[] = [
  {
    id: 'mcp-hub-default',
    name: 'York IE HUB',
    enabled: true,
    status: 'connected',
    toolCount: 12,
  },
  {
    id: 'mcp-launchpad-default',
    name: 'R&D Launchpad',
    enabled: false,
    status: 'disabled',
    toolCount: 0,
  },
  {
    id: 'mcp-gtm-pulse-default',
    name: 'GTM Pulse',
    enabled: true,
    status: 'failed',
    toolCount: 0,
  },
];

describe('extractHubProfileFields', () => {
  it('reads designation / function / squad from nested employeeData', () => {
    const fields = extractHubProfileFields({
      data: {
        employeeData: {
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@york.ie',
          designation: 'Engineering Manager',
          function: { name: 'Engineering' },
          squad: 'Platform',
          department: 'Product',
        },
      },
    });

    expect(fields).toEqual({
      title: 'Engineering Manager',
      functionName: 'Engineering',
      squad: 'Platform',
      department: 'Product',
      name: 'Ada Lovelace',
      email: 'ada@york.ie',
    });
  });

  it('merges preferring next non-null fields', () => {
    const merged = mergeHubProfileFields(
      { title: 'IC', functionName: null },
      { title: null, functionName: 'GTM', squad: 'Growth' }
    );
    expect(merged.title).toBe('IC');
    expect(merged.functionName).toBe('GTM');
    expect(merged.squad).toBe('Growth');
  });
});

describe('welcome connector fingerprint + icons', () => {
  it('builds fingerprint from enabled ids only', () => {
    expect(buildConnectorFingerprint(connectors)).toBe('mcp-gtm-pulse-default|mcp-hub-default');
  });

  it('validates icon allowlist', () => {
    expect(isWelcomeActionIcon('Rocket')).toBe(true);
    expect(isWelcomeActionIcon('NotAnIcon')).toBe(false);
  });

  it('formats profile summary', () => {
    expect(
      formatWelcomeProfileSummary({
        email: 'ada@york.ie',
        name: 'Ada',
        title: 'EM',
        functionName: 'Engineering',
        squad: null,
        department: null,
      })
    ).toBe('Ada · ada@york.ie · EM · Engineering');
  });
});

describe('parseAndValidateWelcomeChips', () => {
  it('clamps, drops unknown icons/connectors, and enriches names', () => {
    const chips = parseAndValidateWelcomeChips(
      [
        {
          id: 'Hub Timesheet!!',
          label: 'Log my Hub timesheet hours this week please extra',
          prompt: 'Help with timesheet',
          icon: 'Calendar',
          requiresConnectorId: 'mcp-hub-default',
        },
        {
          id: 'bad',
          label: 'Bad',
          prompt: 'x',
          icon: 'Nope',
          requiresConnectorId: 'not-a-real-server',
        },
        { id: 'dup', label: 'A', prompt: 'a', icon: 'FileText' },
        { id: 'dup', label: 'B', prompt: 'b', icon: 'FileText' },
        { label: 'No id', prompt: 'c', icon: 'Rocket' },
        { id: 'extra-1', label: 'E1', prompt: 'e1', icon: 'Target' },
        { id: 'extra-2', label: 'E2', prompt: 'e2', icon: 'Users' },
        { id: 'extra-3', label: 'E3', prompt: 'e3', icon: 'Briefcase' },
      ],
      connectors
    );

    expect(chips.length).toBeLessThanOrEqual(6);
    expect(chips[0].id).toBe('hub-timesheet');
    expect(chips[0].label.length).toBeLessThanOrEqual(28);
    expect(chips[0].requiresConnectorId).toBe('mcp-hub-default');
    expect(chips[0].requiresConnectorName).toBe('York IE HUB');

    const bad = chips.find((c) => c.id === 'bad');
    expect(bad?.icon).toBe('FileText');
    expect(bad?.requiresConnectorId).toBeNull();
  });

  it('returns empty for non-arrays', () => {
    expect(parseAndValidateWelcomeChips({ not: 'array' }, connectors)).toEqual([]);
  });
});

describe('static fallback chips', () => {
  it('tags Hub / LaunchPad / GTM when present in snapshot', () => {
    const chips = getStaticFallbackChips(connectors);
    expect(chips.length).toBe(6);
    const hub = chips.find((c) => c.id === 'hub-timesheet');
    expect(hub?.requiresConnectorId).toBe('mcp-hub-default');
    expect(hub?.requiresConnectorName).toBe('York IE HUB');

    const lp = chips.find((c) => c.id === 'launchpad-release');
    expect(lp?.requiresConnectorId).toBe('mcp-launchpad-default');

    const enriched = enrichChipsWithConnectorNames(
      [{ id: 'x', label: 'X', prompt: 'x', icon: 'Mail', requiresConnectorId: 'mcp-hub-default' }],
      connectors
    );
    expect(enriched[0].requiresConnectorName).toBe('York IE HUB');
  });
});
