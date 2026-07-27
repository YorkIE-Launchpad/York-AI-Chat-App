import { BrowserWindow } from 'electron';

let oauthBrowserWindow: BrowserWindow | null = null;

/** Close the dedicated Electron OAuth window if open. */
export function closeOAuthBrowserWindow(): void {
  if (oauthBrowserWindow && !oauthBrowserWindow.isDestroyed()) {
    oauthBrowserWindow.close();
  }
  oauthBrowserWindow = null;
}

/**
 * Open authorize URL in an Electron BrowserWindow so main can auto-close after
 * the loopback callback (system browsers block window.close() on script-opened tabs).
 */
export function openOAuthBrowserWindow(
  authUrl: string,
  title = 'Sign in',
  options?: { onClosed?: () => void }
): void {
  closeOAuthBrowserWindow();
  const onClosed = options?.onClosed;
  oauthBrowserWindow = new BrowserWindow({
    width: 520,
    height: 720,
    show: true,
    autoHideMenuBar: true,
    title,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  oauthBrowserWindow.on('closed', () => {
    oauthBrowserWindow = null;
    onClosed?.();
  });
  void oauthBrowserWindow.loadURL(authUrl);
}
