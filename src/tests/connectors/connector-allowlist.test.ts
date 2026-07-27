import { describe, expect, it } from 'vitest';
import {
  assertAllowedGoogleConnectorEmail,
  assertAllowedSlackWorkspace,
  isAllowedGoogleConnectorEmail,
  isAllowedSlackWorkspace,
} from '../../main/connectors/connector-allowlist';

describe('connector allowlist', () => {
  describe('isAllowedGoogleConnectorEmail', () => {
    it('allows @york.ie emails case-insensitively', () => {
      expect(isAllowedGoogleConnectorEmail('ada@york.ie')).toBe(true);
      expect(isAllowedGoogleConnectorEmail('Ada@York.IE')).toBe(true);
      expect(isAllowedGoogleConnectorEmail('  ada@york.ie  ')).toBe(true);
    });

    it('rejects non-york.ie and missing emails', () => {
      expect(isAllowedGoogleConnectorEmail('ada@gmail.com')).toBe(false);
      expect(isAllowedGoogleConnectorEmail('ada@yorkie.com')).toBe(false);
      expect(isAllowedGoogleConnectorEmail('york.ie')).toBe(false);
      expect(isAllowedGoogleConnectorEmail(null)).toBe(false);
      expect(isAllowedGoogleConnectorEmail(undefined)).toBe(false);
      expect(isAllowedGoogleConnectorEmail('')).toBe(false);
    });

    it('assert throws a clear error', () => {
      expect(() => assertAllowedGoogleConnectorEmail('ada@gmail.com', 'Gmail')).toThrow(
        'Only @york.ie Google accounts can connect Gmail'
      );
    });
  });

  describe('isAllowedSlackWorkspace', () => {
    it('allows york-ie.slack.com URL', () => {
      expect(
        isAllowedSlackWorkspace({
          teamUrl: 'https://york-ie.slack.com/',
        })
      ).toBe(true);
    });

    it('allows York.ie / york-ie team names', () => {
      expect(isAllowedSlackWorkspace({ teamName: 'York.ie' })).toBe(true);
      expect(isAllowedSlackWorkspace({ teamName: 'york-ie' })).toBe(true);
      expect(isAllowedSlackWorkspace({ teamName: 'York IE' })).toBe(true);
    });

    it('allows matching configured team id', () => {
      expect(
        isAllowedSlackWorkspace({
          teamId: 'T123',
          allowedTeamId: 'T123',
          teamName: 'Other Co',
        })
      ).toBe(true);
    });

    it('rejects other workspaces', () => {
      expect(
        isAllowedSlackWorkspace({
          teamId: 'T999',
          teamName: 'Acme Corp',
          teamUrl: 'https://acme.slack.com/',
          allowedTeamId: 'T123',
        })
      ).toBe(false);
      expect(isAllowedSlackWorkspace({})).toBe(false);
    });

    it('assert throws a clear error', () => {
      expect(() =>
        assertAllowedSlackWorkspace({
          teamName: 'Acme',
          teamUrl: 'https://acme.slack.com/',
        })
      ).toThrow('Only the York.ie Slack workspace can be connected');
    });
  });
});
