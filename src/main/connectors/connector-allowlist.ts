/** Hardcoded Google connector email domain (product rule, not AUTH_ALLOWED_DOMAIN). */
export const CONNECTOR_ALLOWED_GOOGLE_DOMAIN = '@york.ie';

const SLACK_ALLOWED_HOST = 'york-ie.slack.com';
const SLACK_ALLOWED_TEAM_SLUGS = new Set(['yorkie', 'york-ie']);

export function isAllowedGoogleConnectorEmail(email: string | null | undefined): boolean {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  return trimmed.endsWith(CONNECTOR_ALLOWED_GOOGLE_DOMAIN);
}

function normalizeSlackTeamSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function isAllowedSlackWorkspace(input: {
  teamId?: string | null;
  teamName?: string | null;
  teamUrl?: string | null;
  allowedTeamId?: string | null;
}): boolean {
  const allowedTeamId = input.allowedTeamId?.trim();
  const teamId = input.teamId?.trim();
  if (allowedTeamId && teamId && teamId === allowedTeamId) {
    return true;
  }

  if (input.teamUrl) {
    try {
      const host = new URL(input.teamUrl).hostname.toLowerCase();
      if (host === SLACK_ALLOWED_HOST) {
        return true;
      }
    } catch {
      // ignore invalid URL
    }
  }

  if (input.teamName) {
    const slug = normalizeSlackTeamSlug(input.teamName);
    if (SLACK_ALLOWED_TEAM_SLUGS.has(slug)) {
      return true;
    }
  }

  return false;
}

export function assertAllowedGoogleConnectorEmail(
  email: string | null | undefined,
  connectorLabel: string
): void {
  if (!isAllowedGoogleConnectorEmail(email)) {
    throw new Error(`Only @york.ie Google accounts can connect ${connectorLabel}`);
  }
}

export function assertAllowedSlackWorkspace(input: {
  teamId?: string | null;
  teamName?: string | null;
  teamUrl?: string | null;
  allowedTeamId?: string | null;
}): void {
  if (!isAllowedSlackWorkspace(input)) {
    throw new Error('Only the York.ie Slack workspace can be connected');
  }
}
