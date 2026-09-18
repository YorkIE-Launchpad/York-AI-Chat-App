export type UpdaterStatusKind =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported';

export interface UpdaterStatus {
  status: UpdaterStatusKind;
  currentVersion: string;
  /** Version available for download / ready to install */
  version?: string;
  /** Download progress 0–100 when status is downloading */
  percent?: number;
  message?: string;
  /** macOS: Squirrel accepted the downloaded build (false while staging or after signature failure). */
  installPrepared?: boolean;
}

/** Show primary "Restart to update" control (prod: ready only; Vite dev: also when download is still available). */
export function shouldShowRestartToUpdate(
  status: UpdaterStatusKind,
  opts?: { isViteDev?: boolean; installPrepared?: boolean }
): boolean {
  if (status === 'ready') {
    return opts?.installPrepared !== false;
  }
  if (opts?.isViteDev && status === 'available') return true;
  return false;
}

/** Ready text in About/Settings — only after Squirrel staging succeeds. */
export function shouldShowUpdateReadyMessage(status: UpdaterStatus): boolean {
  return (
    status.status === 'ready' &&
    Boolean(status.version) &&
    status.installPrepared !== false
  );
}

/** Squirrel is validating/staging the downloaded zip (restart not available yet). */
export function isUpdateStagingForInstall(status: UpdaterStatus): boolean {
  return status.status === 'ready' && status.installPrepared === false;
}
