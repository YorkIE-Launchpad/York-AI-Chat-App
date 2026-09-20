import type { CollabTurnLease } from '../collab/shared-session-doc';
import type { CollabWsStatus } from '../collab/types';

export const SHARED_DOC_LOCK_HELD = 'doc_lock_held';

export interface SharedDocLockState {
  docId: string;
  connection: CollabWsStatus;
  lease: CollabTurnLease | null;
  localSub: string;
  /** Whether this client requested edit capability (watch with canEdit). */
  canEdit: boolean;
  holderIsOther: boolean;
  holderName?: string;
}
