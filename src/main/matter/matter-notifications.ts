import { showOsNotification, focusAndNavigate } from '../os-notifications';

function focusMatterWindow(): void {
  focusAndNavigate('matter');
}

/** Optional GrowthOS Slack bot DM when "Control from Slack" is connected. */
type SlackAlerter = (title: string, body: string) => void;

let slackAlerter: SlackAlerter | null = null;

export function setMatterSlackAlerter(alerter: SlackAlerter | null): void {
  slackAlerter = alerter;
}

function maybeSlackAlert(title: string, body: string): void {
  try {
    slackAlerter?.(title, body);
  } catch {
    // Alerts must never break Matter scans / tickers.
  }
}

export function notifyMatterBrief(options: {
  title: string;
  body: string;
  criticalCount?: number;
  /** Also DM via the GrowthOS Slack bot (e.g. opportunity overflow). */
  alsoSlack?: boolean;
}): void {
  showOsNotification({
    tag: 'Matter',
    title: options.title,
    body: options.body,
    onClick: () => focusMatterWindow(),
  });
  if (options.alsoSlack) maybeSlackAlert(options.title, options.body);
}

export function notifyMatterItem(options: {
  kind: 'reminder' | 'expired' | 'snooze_wake' | 'scan_critical' | 'scan_warning' | 'opportunity';
  title: string;
  body: string;
  itemId?: string;
}): void {
  const prefix =
    options.kind === 'opportunity'
      ? 'Matter — opportunity'
      : options.kind === 'reminder'
        ? 'Matter — reminder'
        : options.kind === 'expired'
          ? 'Matter — expired'
          : options.kind === 'snooze_wake'
            ? 'Matter — back on radar'
            : options.kind === 'scan_critical'
              ? 'Matter — urgent'
              : 'Matter — warning';
  const title = options.title ? `${prefix}: ${options.title}` : prefix;
  showOsNotification({
    tag: 'Matter',
    title,
    body: options.body,
    onClick: () => focusMatterWindow(),
  });
  // New opportunities also DM the GrowthOS bot when Slack remote control is on.
  if (options.kind === 'opportunity') maybeSlackAlert(title, options.body);
}
