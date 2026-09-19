export type SharedDocKind = 'html' | 'markdown';
export type SharedDocPermission = 'view' | 'edit';

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

export type SharedDocAccess = SharedDocPermission | 'owner';

export interface SharedDocWithAccess extends SharedDocRecord {
  permission: SharedDocAccess;
}

export interface CognitoCaller {
  sub: string;
  email?: string;
}
