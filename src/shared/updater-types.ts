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
}
