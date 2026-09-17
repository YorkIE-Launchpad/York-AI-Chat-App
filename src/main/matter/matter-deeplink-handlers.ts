import { app, BrowserWindow } from 'electron';
import path from 'path';
import {
  MATTER_DEEP_LINK_SCHEME,
  parseMatterDeepLinkUrl,
  type MatterOpenDeepLink,
} from '../../shared/matter-deeplink';
import { log } from '../utils/logger';

let pendingDeepLink: MatterOpenDeepLink | null = null;

type MainWindowAccess = {
  getMainWindow: () => BrowserWindow | null;
  focusMainWindow: () => void;
};

function sendDeepLinkToRenderer(win: BrowserWindow, link: MatterOpenDeepLink): void {
  if (win.isDestroyed()) return;
  const deliver = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('matter:openDeepLink', link);
    }
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', deliver);
  } else {
    deliver();
  }
}

export function deliverMatterDeepLink(
  link: MatterOpenDeepLink,
  access: MainWindowAccess
): void {
  access.focusMainWindow();
  const win = access.getMainWindow();
  if (!win || win.isDestroyed()) {
    pendingDeepLink = link;
    return;
  }
  sendDeepLinkToRenderer(win, link);
}

export function flushPendingMatterDeepLink(access: MainWindowAccess): void {
  if (!pendingDeepLink) return;
  const link = pendingDeepLink;
  pendingDeepLink = null;
  deliverMatterDeepLink(link, access);
}

export function handleMatterDeepLinkUrl(
  raw: string,
  access: MainWindowAccess
): boolean {
  const link = parseMatterDeepLinkUrl(raw);
  if (!link) return false;
  log('[Matter] Deep link:', link.type);
  deliverMatterDeepLink(link, access);
  return true;
}

export function registerMatterDeepLinkProtocol(): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;

  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(MATTER_DEEP_LINK_SCHEME);
  } else if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(MATTER_DEEP_LINK_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(MATTER_DEEP_LINK_SCHEME);
  }
}

export function installMatterDeepLinkListeners(access: MainWindowAccess): void {
  if (process.platform === 'darwin') {
    app.on('open-url', (event, url) => {
      event.preventDefault();
      handleMatterDeepLinkUrl(url, access);
    });
  }

  app.on('second-instance', (_event, argv) => {
    const urlArg = argv.find((arg) => arg.startsWith(`${MATTER_DEEP_LINK_SCHEME}:`));
    if (urlArg) {
      handleMatterDeepLinkUrl(urlArg, access);
    }
  });
}

export function consumeLaunchDeepLinkArgv(argv: string[]): boolean {
  const urlArg = argv.find((arg) => arg.startsWith(`${MATTER_DEEP_LINK_SCHEME}:`));
  if (!urlArg) return false;
  const link = parseMatterDeepLinkUrl(urlArg);
  if (link) pendingDeepLink = link;
  return Boolean(link);
}
