import { describe, expect, it } from 'vitest';
import { resolveGoogleCalendarConnectorId } from '../../main/mcp/google-calendar-connector';

describe('resolveGoogleCalendarConnectorId', () => {
  it('returns google when connected', () => {
    expect(resolveGoogleCalendarConnectorId((id) => id === 'google')).toBe('google');
  });

  it('throws when Google is disconnected', () => {
    expect(() => resolveGoogleCalendarConnectorId(() => false)).toThrow(
      /Google Calendar MCP requires Google/
    );
  });
});
