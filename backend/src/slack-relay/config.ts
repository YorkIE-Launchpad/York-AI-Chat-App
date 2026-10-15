/**
 * Slack remote-control relay configuration. Every field is required; a partial
 * config disables the relay entirely (routes answer 503, upgrades are refused).
 */

export interface SlackRelayConfig {
  botToken: string;
  signingSecret: string;
  appId: string;
  teamId: string;
  /** Lower-cased email domains allowed to register a desktop (e.g. `york.ie`). */
  allowedEmailDomains: string[];
  /** Optional lower-cased email allowlist layered on top of the domain check. */
  allowedEmails: Set<string> | null;
}

const DEFAULT_ALLOWED_EMAIL_DOMAINS = ['york.ie'];

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() || '';
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveSlackRelayConfig(
  env: NodeJS.ProcessEnv = process.env
): SlackRelayConfig | null {
  if (readEnv(env, 'SLACK_RELAY_ENABLED').toLowerCase() !== 'true') return null;

  const botToken = readEnv(env, 'SLACK_BOT_TOKEN');
  const signingSecret = readEnv(env, 'SLACK_SIGNING_SECRET');
  const appId = readEnv(env, 'SLACK_APP_ID');
  const teamId = readEnv(env, 'SLACK_ALLOWED_TEAM_ID');
  if (!botToken.startsWith('xoxb-') || !signingSecret || !appId || !teamId) return null;

  const domains = parseList(readEnv(env, 'SLACK_RELAY_ALLOWED_EMAIL_DOMAINS'));
  const emails = parseList(readEnv(env, 'SLACK_RELAY_ALLOWED_EMAILS'));

  return {
    botToken,
    signingSecret,
    appId,
    teamId,
    allowedEmailDomains: domains.length > 0 ? domains : DEFAULT_ALLOWED_EMAIL_DOMAINS,
    allowedEmails: emails.length > 0 ? new Set(emails) : null,
  };
}

export function isEmailAllowed(email: string, config: SlackRelayConfig): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return false;
  const domain = normalized.slice(at + 1);
  if (!config.allowedEmailDomains.includes(domain)) return false;
  if (config.allowedEmails && !config.allowedEmails.has(normalized)) return false;
  return true;
}
