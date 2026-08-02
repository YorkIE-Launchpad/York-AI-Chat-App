import { Notification, BrowserWindow } from 'electron';
import { logWarn } from '../utils/logger';

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
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
        void win.webContents.executeJavaScript(`window.__navigate && window.__navigate('matter')`);
      }
    });
    notification.show();
  } catch (error) {
    logWarn('[Matter] Notification failed:', error);
  }
}
