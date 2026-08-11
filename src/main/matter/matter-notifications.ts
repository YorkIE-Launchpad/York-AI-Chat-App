import { showOsNotification, focusAndNavigate } from '../os-notifications';

function focusMatterWindow(): void {
  focusAndNavigate('matter');
}

export function notifyMatterBrief(options: {
  title: string;
  body: string;
  criticalCount?: number;
}): void {
  showOsNotification({
    tag: 'Matter',
    title: options.title,
    body: options.body,
    onClick: () => focusMatterWindow(),
  });
}

export function notifyMatterItem(options: {
  kind: 'reminder' | 'expired' | 'snooze_wake' | 'scan_critical' | 'scan_warning';
  title: string;
  body: string;
  itemId?: string;
}): void {
  const prefix =
    options.kind === 'reminder'
      ? 'Matter — reminder'
      : options.kind === 'expired'
        ? 'Matter — expired'
        : options.kind === 'snooze_wake'
          ? 'Matter — back on radar'
          : options.kind === 'scan_critical'
            ? 'Matter — urgent'
            : 'Matter — warning';
  showOsNotification({
    tag: 'Matter',
    title: options.title ? `${prefix}: ${options.title}` : prefix,
    body: options.body,
    onClick: () => focusMatterWindow(),
  });
}
