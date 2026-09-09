import type { CollabMember, CollabTurnLease } from './shared-session-doc';

export type CollabWsStatus = 'connecting' | 'connected' | 'disconnected';

export interface CollabRoomState {
  sessionId: string;
  roomId: string;
  role: 'owner' | 'member';
  inviteToken?: string;
  connection: CollabWsStatus;
  peersOnline: boolean;
  lease: CollabTurnLease | null;
  members: Record<string, CollabMember>;
  localSub: string;
  canPrompt: boolean;
  awarenessPartial: { text: string; fromName: string } | null;
}

export interface CollabAwarenessEvent {
  sessionId: string;
  partial: { text: string; fromName: string } | null;
  peersOnline: boolean;
  lease: CollabTurnLease | null;
}
