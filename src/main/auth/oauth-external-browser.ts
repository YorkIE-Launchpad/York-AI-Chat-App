import { shell } from 'electron';

/**
 * Open an OAuth authorize URL in the user's default browser instead of a
 * dedicated Electron `BrowserWindow`.
 *
 * `shell.openExternal` hands the URL to the OS, so when Chrome (or the user's
 * default browser) is already running the sign-in opens as a new tab in that
 * existing window — reusing its profile, cookies, password manager, and any
 * already-signed-in Google account — rather than a separate, blank app window.
 *
 * Trade-off: the app cannot close or rewrite a tab it does not own. Completion
 * is detected via the loopback/relay callback server, and the callback page
 * tells the user they can close the tab and return to York GrowthOS.
 */
export async function openOAuthInExternalBrowser(authUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    throw new Error('Invalid OAuth authorization URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OAuth authorization URL uses unsupported protocol: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}
