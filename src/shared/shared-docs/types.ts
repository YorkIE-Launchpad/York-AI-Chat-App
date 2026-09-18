export type SharedDocKind = 'html' | 'markdown';
export type SharedDocPermission = 'view' | 'edit';

export interface SharedDocAclEntry {
  principal: string;
  permission: SharedDocPermission;
}

export interface SharedDocVersionEntry {
  version: number;
  s3Key: string;
  updatedBy: string;
  updatedAt: string;
}

export interface SharedDocRecord {
  id: string;
  ownerSub: string;
  ownerEmail: string;
  title: string;
  kind: SharedDocKind;
  s3Key: string;
  version: number;
  contentType: string;
  createdAt: string;
  updatedAt: string;
  acl: SharedDocAclEntry[];
  versions: SharedDocVersionEntry[];
}

/** Caller-specific view of a shared document. */
export interface SharedDocWithAccess extends SharedDocRecord {
  permission: SharedDocPermission | 'owner';
}

export interface SharedDocLocalLink {
  docId: string;
  localPath: string;
  s3Key: string;
  version: number;
  permission: SharedDocPermission | 'owner';
  sessionId: string;
  title: string;
  kind: SharedDocKind;
}

export interface SharedDocPreviewMeta {
  docId: string;
  permission: SharedDocPermission | 'owner';
  version: number;
}

export type SharedDocsSyncEvent = {
  sessionId: string;
  localPath: string;
  synced: boolean;
  error?: string;
  version?: number;
};
