import { Notification, BrowserWindow } from 'electron';
import { logWarn } from '../utils/logger';

function focusMatterWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    void win.webContents.executeJavaScript(`window.__navigate && window.__navigate('matter')`);
  }
}

export function notifyMatterBrief(options: {
  title: string;
  body: string;
  criticalCount?: number;
}): void {
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: options.title,
      body: options.body,
      silent: false,
    });
    notification.on('click', () => {
      focusMatterWindow();
    });
    notification.show();
  } catch (error) {
    logWarn('[Matter] Notification failed:', error);
  }
}

export function notifyMatterItem(options: {
  kind: 'reminder' | 'expired' | 'snooze_wake';
  title: string;
  body: string;
  itemId?: string;
}): void {
  try {
    if (!Notification.isSupported()) return;
    const prefix =
      options.kind === 'reminder'
        ? 'Matter — reminder'
        : options.kind === 'expired'
          ? 'Matter — expired'
          : 'Matter — back on radar';
    const notification = new Notification({
      title: options.title ? `${prefix}: ${options.title}` : prefix,
      body: options.body,
      silent: false,
    });
    notification.on('click', () => {
      focusMatterWindow();
    });
    notification.show();
  } catch (error) {
    logWarn('[Matter] Item notification failed:', error);
  }
}
