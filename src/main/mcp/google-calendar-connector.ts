/**
 * Google Calendar MCP uses the unified Google connector OAuth token
 * (scopes include calendar.readonly).
 */
export function resolveGoogleCalendarConnectorId(
  isConnected: (connectorId: 'google') => boolean
): 'google' {
  if (isConnected('google')) return 'google';
  throw new Error('Google Calendar MCP requires Google to be connected.');
}
