export type SharedDocKind = 'html' | 'markdown';
export type SharedDocPermission = 'view' | 'edit';

export function sharedDocAccessCanEdit(
  permission: SharedDocPermission | 'owner' | string | undefined
): boolean {
  return permission === 'edit' || permission === 'owner';
}

export interface SharedDocRecord {
  id: string;
  ownerSub: string;
  ownerEmail: string;
  title: string;
  kind: SharedDocKind;
  s3Key: string;
  s3UpdatedAt: string;
  contentType: string;
}

/** Caller-specific view of a shared document. */
export interface SharedDocWithAccess extends SharedDocRecord {
  permission: SharedDocPermission | 'owner';
}

export interface SharedDocLocalLink {
  docId: string;
  localPath: string;
  s3Key: string;
  s3UpdatedAt: string;
  permission: SharedDocPermission | 'owner';
  sessionId: string;
  title: string;
  kind: SharedDocKind;
}

export interface SharedDocPreviewMeta {
  docId: string;
  permission: SharedDocPermission | 'owner';
  s3UpdatedAt: string;
}

export type SharedDocsSyncEvent = {
  sessionId: string;
  localPath: string;
  synced: boolean;
  error?: string;
  s3UpdatedAt?: string;
};
