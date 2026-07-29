import { describe, expect, it } from 'vitest';
import { resolveGoogleCalendarConnectorId } from '../../main/mcp/google-calendar-connector';

describe('resolveGoogleCalendarConnectorId', () => {
  it('prefers gmail when connected', () => {
    expect(resolveGoogleCalendarConnectorId((id) => id === 'gmail')).toBe('gmail');
  });

  it('falls back to google-drive when gmail is disconnected', () => {
    expect(resolveGoogleCalendarConnectorId((id) => id === 'google-drive')).toBe('google-drive');
  });

  it('throws when neither Google connector is connected', () => {
    expect(() => resolveGoogleCalendarConnectorId(() => false)).toThrow(/Gmail or Google Drive/);
  });
});
