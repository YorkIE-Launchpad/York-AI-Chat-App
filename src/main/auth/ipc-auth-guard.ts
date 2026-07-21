import { ipcMain } from 'electron';
import { ensureAuthenticatedSession, AuthRequiredError } from './session';

/** IPC channels that do not require an authenticated session. */
export const PUBLIC_IPC_CHANNELS = new Set([
  'auth.getStatus',
  'auth.getOAuthDebug',
  'auth.startGoogleLogin',
  'auth.me',
  'auth.logout',
  'auth.refresh',
  'auth.submitOAuthCode',
  'get-version',
  'system.getTheme',
  'shell.openExternal',
  'logs.write',
]);

let patchInstalled = false;

export function installIpcAuthGuard(): void {
  if (patchInstalled) return;
  patchInstalled = true;

  const originalHandle = ipcMain.handle.bind(ipcMain);

  ipcMain.handle = function patchedHandle(
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
  ) {
    if (PUBLIC_IPC_CHANNELS.has(channel)) {
      return originalHandle(channel, listener);
    }
    return originalHandle(channel, async (event, ...args) => {
      try {
        await ensureAuthenticatedSession();
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          throw Object.assign(new Error(error.message), { code: error.code });
        }
        throw error;
      }
      return listener(event, ...args);
    });
  } as typeof ipcMain.handle;
}
