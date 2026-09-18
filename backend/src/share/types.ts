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

export type SharedDocAccess = SharedDocPermission | 'owner';

export interface SharedDocWithAccess extends SharedDocRecord {
  permission: SharedDocAccess;
}

export interface CognitoCaller {
  sub: string;
  email?: string;
}
