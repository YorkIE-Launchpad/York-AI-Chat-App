/**
 * Google Calendar MCP reuses Gmail or Drive connector OAuth tokens
 * (both already request calendar.readonly).
 */
export function resolveGoogleCalendarConnectorId(
  isConnected: (connectorId: 'gmail' | 'google-drive') => boolean
): 'gmail' | 'google-drive' {
  if (isConnected('gmail')) return 'gmail';
  if (isConnected('google-drive')) return 'google-drive';
  throw new Error(
    'Google Calendar MCP requires Gmail or Google Drive to be connected (same Google OAuth).'
  );
}
