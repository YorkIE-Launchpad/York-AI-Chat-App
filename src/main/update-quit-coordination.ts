/** Reset main-process quit flags when an in-app update install aborts (Squirrel / signature / watchdog). */
let onUpdateInstallAborted: (() => void) | null = null;
let onUpdateInstallWillQuit: (() => void) | null = null;

export function registerUpdateInstallAbortHandler(handler: () => void): void {
  onUpdateInstallAborted = handler;
}

export function notifyUpdateInstallAborted(): void {
  try {
    onUpdateInstallAborted?.();
  } catch {
    // best-effort
  }
}

/** Sync teardown (MCP children, Matter, tray, nav) immediately before Squirrel quit. */
export function registerUpdateInstallWillQuitHandler(handler: () => void): void {
  onUpdateInstallWillQuit = handler;
}

export function notifyUpdateInstallWillQuit(): void {
  try {
    onUpdateInstallWillQuit?.();
  } catch {
    // best-effort
  }
}
