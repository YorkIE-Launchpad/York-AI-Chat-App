/**
 * Shared Electron OS (native) notifications for main process.
 * Retains Notification instances so Chromium does not GC them before they appear.
 */
import { Notification, BrowserWindow } from 'electron';
import { log, logWarn } from './utils/logger';

export interface ShowOsNotificationOptions {
  title: string;
  body: string;
  /** Log namespace for diagnostics. Default: "OS" */
  tag?: string;
  /** Called when the user clicks the notification body. */
  onClick?: () => void;
  silent?: boolean;
}

/** Severity rank for Matter escalation checks (exported for tests). */
export const MATTER_SEVERITY_RANK: Record<string, number> = {
  signal: 1,
  healthy: 2,
  warning: 3,
  critical: 4,
};

const MAX_MATTER_SCAN_ITEM_NOTIFICATIONS = 5;

/** Keep refs so Chromium does not GC notifications before they appear. */
const retainedNotifications = new Set<Notification>();

/**
 * Focus a BrowserWindow: restore if minimized, show, focus.
 * Uses first non-destroyed window when none is provided.
 */
export function focusAppWindow(win?: BrowserWindow | null): BrowserWindow | null {
  const target =
    win && !win.isDestroyed()
      ? win
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
  if (!target) return null;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

/**
 * Focus the app and navigate via renderer `window.__navigate(page, tab?, sessionId?)`.
 */
export function focusAndNavigate(
  page: string,
  options?: { tab?: string; sessionId?: string; win?: BrowserWindow | null }
): void {
  const target = focusAppWindow(options?.win);
  if (!target) return;
  const tab = options?.tab != null ? JSON.stringify(options.tab) : 'undefined';
  const sessionId = options?.sessionId != null ? JSON.stringify(options.sessionId) : 'undefined';
  void target.webContents
    .executeJavaScript(
      `window.__navigate && window.__navigate(${JSON.stringify(page)}, ${tab}, ${sessionId})`
    )
    .catch((err) => {
      logWarn('[OS Notification] navigate failed:', err);
    });
}

export function showOsNotification(options: ShowOsNotificationOptions): void {
  const tag = options.tag || 'OS';
  log(`[${tag}] Showing OS notification: ${options.title}`);
  if (!Notification.isSupported()) {
    logWarn(`[${tag}] Electron Notification API is not supported on this platform`);
    return;
  }
  try {
    const notification = new Notification({
      title: options.title,
      body: options.body,
      silent: options.silent ?? false,
      timeoutType: 'default',
      urgency: 'normal',
    });
    retainedNotifications.add(notification);
    if (options.onClick) {
      notification.on('click', () => {
        try {
          options.onClick?.();
        } catch (error) {
          logWarn(`[${tag}] Notification click handler failed:`, error);
        }
      });
    }
    notification.on('failed', (event, error) => {
      logWarn(
        `[${tag}] OS notification failed — on macOS Electron 41+ requires a valid code signature ` +
          '(dev: npm run brand:electron re-signs the host) and Notification Center permission for this app',
        error || event
      );
      retainedNotifications.delete(notification);
    });
    notification.on('close', () => {
      retainedNotifications.delete(notification);
    });
    notification.on('show', () => {
      log(`[${tag}] OS notification shown`);
    });
    notification.show();
  } catch (error) {
    logWarn(`[${tag}] Failed to show OS notification`, error);
  }
}

export interface MatterScanNotifyPrev {
  fingerprint: string;
  severity: string;
  status: string;
}

export interface MatterScanNotifyItem {
  fingerprint: string;
  severity: string;
  status: string;
  title: string;
  summary?: string | null;
  whyItMatters?: string | null;
}

/**
 * Decide which Matter items should get a per-scan OS notification.
 * Notifies new fingerprints, resurfaced items, or severity escalations into warning/critical.
 * Caps at MAX_MATTER_SCAN_ITEM_NOTIFICATIONS; returns overflow count for a summary brief.
 */
export function selectMatterScanNotifyItems(
  previous: MatterScanNotifyPrev[],
  after: MatterScanNotifyItem[],
  maxItems = MAX_MATTER_SCAN_ITEM_NOTIFICATIONS
): { items: MatterScanNotifyItem[]; overflow: number } {
  const prevByFp = new Map(previous.map((p) => [p.fingerprint, p]));
  const candidates: MatterScanNotifyItem[] = [];

  for (const item of after) {
    if (item.severity !== 'critical' && item.severity !== 'warning') continue;
    if (item.status !== 'active' && item.status !== 'resurfaced') continue;

    const prev = prevByFp.get(item.fingerprint);
    if (!prev) {
      candidates.push(item);
      continue;
    }
    if (item.status === 'resurfaced') {
      candidates.push(item);
      continue;
    }
    const prevRank = MATTER_SEVERITY_RANK[prev.severity] ?? 0;
    const nextRank = MATTER_SEVERITY_RANK[item.severity] ?? 0;
    const wasUrgent = prev.severity === 'critical' || prev.severity === 'warning';
    if (!wasUrgent && nextRank >= (MATTER_SEVERITY_RANK.warning ?? 3)) {
      candidates.push(item);
      continue;
    }
    if (wasUrgent && nextRank > prevRank) {
      candidates.push(item);
    }
  }

  if (candidates.length <= maxItems) {
    return { items: candidates, overflow: 0 };
  }
  return {
    items: candidates.slice(0, maxItems),
    overflow: candidates.length - maxItems,
  };
}

/** Truncate body text for OS notification body (exported for tests). */
export function truncateNotifyBody(text: string, max = 200): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}
