/**
 * Shared-chat collab: local Y.Doc + ephemeral backend relay + SQLite projection.
 */
import { randomUUID } from 'crypto';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { BrowserWindow } from 'electron';
import { resolveBackendUrl } from '../../shared/backend-config';
import {
  clearLeaseIfHolderOffline,
  canPromptWithLease,
  commitCollabMessage,
  getCollabMaps,
  isLeaseHeldByOther,
  listOrderedMessages,
  messageToCollabPortable,
  readMembers,
  readTurnLease,
  refreshLease,
  releaseLeaseIfHolder,
  seedCollabMeta,
  tryAcquireLease,
  upsertCollabMember,
  type CollabPortableMessage,
} from '../../shared/collab/shared-session-doc';
import type { CollabRoomState } from '../../shared/collab/types';
import { createCollabRoomId, parseCollabRoomId } from '../../shared/collab/room-id';
import type { Message, Session } from '../../renderer/types';
import { getCurrentSession, ensureAuthenticatedSession } from '../auth/session';
import { log, logError } from '../utils/logger';
import { CollabWsProvider, type CollabWsStatus } from './collab-ws-provider';

export type { CollabRoomState } from '../../shared/collab/types';

interface RoomRuntime {
  sessionId: string;
  roomId: string;
  role: 'owner' | 'member';
  inviteToken?: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  provider: CollabWsProvider;
  connection: CollabWsStatus;
  peersOnline: boolean;
  applyingRemote: boolean;
  leaseRefreshTimer: ReturnType<typeof setInterval> | null;
  knownMessageIds: Set<string>;
}

export interface CollabSyncDeps {
  getSession: (sessionId: string) => Session | null;
  listSessions: () => Session[];
  getMessages: (sessionId: string) => Message[];
  saveMessage: (message: Message) => void;
  createJoinedSession: (input: {
    title: string;
    roomId: string;
    role: 'member';
    meta?: Partial<Session>;
  }) => Session;
  updateSessionCollab: (
    sessionId: string,
    collab: { collabRoomId: string | null; collabRole: 'owner' | 'member' | null }
  ) => void;
  emitSessionUpdate?: (session: Session) => void;
  getWindow: () => BrowserWindow | null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export function getCognitoSubFromSession(): string | null {
  const session = getCurrentSession();
  const token = session?.idToken || session?.accessToken;
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const sub = payload?.sub;
  return typeof sub === 'string' && sub.trim() ? sub.trim() : null;
}

/** @deprecated Prefer parseCollabRoomId — accepts plain room ids or legacy JWTs. */
export function decodeInviteRoomId(inviteOrRoomId: string): string | null {
  return parseCollabRoomId(inviteOrRoomId);
}

function backendHttpBase(): string {
  return resolveBackendUrl().replace(/\/$/, '');
}

function backendWsBase(): string {
  const http = backendHttpBase();
  if (http.startsWith('https://')) return `wss://${http.slice('https://'.length)}`;
  if (http.startsWith('http://')) return `ws://${http.slice('http://'.length)}`;
  return `ws://${http}`;
}

export class CollabSyncService {
  private roomsBySession = new Map<string, RoomRuntime>();
  private sessionByRoom = new Map<string, string>();

  constructor(private deps: CollabSyncDeps) {}

  getState(sessionId: string): CollabRoomState | null {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) {
      const session = this.deps.getSession(sessionId);
      if (!session?.collabRoomId) return null;
      return {
        sessionId,
        roomId: session.collabRoomId,
        role: session.collabRole || 'member',
        connection: 'disconnected',
        peersOnline: false,
        lease: null,
        members: {},
        localSub: getCognitoSubFromSession() || '',
        canPrompt: false,
        awarenessPartial: null,
      };
    }
    const localSub = getCognitoSubFromSession() || '';
    const lease = readTurnLease(rt.doc);
    return {
      sessionId,
      roomId: rt.roomId,
      role: rt.role,
      inviteToken: rt.inviteToken,
      connection: rt.connection,
      peersOnline: rt.peersOnline,
      lease,
      members: readMembers(rt.doc),
      localSub,
      canPrompt: !!localSub && canPromptWithLease(rt.doc, localSub),
      awarenessPartial: this.readAwarenessPartial(rt),
    };
  }

  private readAwarenessPartial(
    rt: RoomRuntime
  ): { text: string; fromName: string } | null {
    const states = rt.awareness.getStates();
    for (const [clientId, state] of states) {
      if (clientId === rt.doc.clientID) continue;
      const partial = state?.partial as { text?: string; fromName?: string } | undefined;
      if (partial?.text) {
        return {
          text: partial.text,
          fromName: partial.fromName || 'Teammate',
        };
      }
    }
    return null;
  }

  private emitState(sessionId: string): void {
    const win = this.deps.getWindow();
    const state = this.getState(sessionId);
    if (win && state) {
      win.webContents.send('collab:state', state);
    }
  }

  private emitAwareness(sessionId: string): void {
    const win = this.deps.getWindow();
    const state = this.getState(sessionId);
    if (win && state) {
      win.webContents.send('collab:awareness', {
        sessionId,
        partial: state.awarenessPartial,
        peersOnline: state.peersOnline,
        lease: state.lease,
      });
    }
  }

  isSharedSession(sessionId: string): boolean {
    return this.roomsBySession.has(sessionId) || !!this.deps.getSession(sessionId)?.collabRoomId;
  }

  canLocalPrompt(sessionId: string): boolean {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) {
      // Not currently connected — if marked shared, block until online
      return !this.deps.getSession(sessionId)?.collabRoomId;
    }
    const sub = getCognitoSubFromSession();
    if (!sub) return false;
    return canPromptWithLease(rt.doc, sub);
  }

  assertCanPrompt(sessionId: string): void {
    if (!this.isSharedSession(sessionId)) return;
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) {
      throw new Error('Reconnect to the shared chat before sending a prompt.');
    }
    const sub = getCognitoSubFromSession();
    if (!sub) throw new Error('Authentication required');
    const displayName = getCurrentSession()?.user?.name || getCurrentSession()?.user?.email || 'User';

    if (isLeaseHeldByOther(rt.doc, sub)) {
      const lease = readTurnLease(rt.doc);
      throw new Error(
        `This shared chat turn belongs to ${lease?.holderName || 'someone else'}. Take the turn before sending a prompt.`
      );
    }

    // Free lease (or already ours) — acquire/refresh so we own the turn for this send
    const result = tryAcquireLease(rt.doc, { sub, displayName });
    if (!result.ok) {
      throw new Error(
        `This shared chat turn belongs to ${result.holder?.holderName || 'someone else'}. Take the turn before sending a prompt.`
      );
    }
    this.startLeaseRefresh(rt, sub);
    this.emitState(sessionId);
  }

  async shareSession(sessionId: string): Promise<{ roomId: string; inviteToken: string }> {
    await ensureAuthenticatedSession();
    const session = this.deps.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.incognito) throw new Error('Incognito chats cannot be shared');

    const existing = this.roomsBySession.get(sessionId);
    if (existing?.roomId) {
      // inviteToken kept as alias of roomId for older UI callers
      return { roomId: existing.roomId, inviteToken: existing.roomId };
    }

    const sub = getCognitoSubFromSession();
    if (!sub) throw new Error('Cognito identity required');
    const displayName = getCurrentSession()?.user?.name || getCurrentSession()?.user?.email || 'User';

    const roomId = existing?.roomId || session.collabRoomId || createCollabRoomId();

    await this.connectRoom({
      sessionId,
      roomId,
      role: 'owner',
      ownerBootstrap: true,
      seedFromLocal: true,
      displayName,
      sub,
    });

    this.deps.updateSessionCollab(sessionId, { collabRoomId: roomId, collabRole: 'owner' });
    const updated = this.deps.getSession(sessionId);
    if (updated) this.deps.emitSessionUpdate?.(updated);

    return { roomId, inviteToken: roomId };
  }

  async joinSession(inviteOrRoomId: string): Promise<{ sessionId: string; roomId: string }> {
    await ensureAuthenticatedSession();
    const roomId = parseCollabRoomId(inviteOrRoomId);
    if (!roomId) throw new Error('Invalid room ID');

    const already = this.deps.listSessions().find((s) => s.collabRoomId === roomId);
    if (already) {
      throw new Error(
        already.collabRole === 'owner'
          ? 'You already shared this chat — open it from your sidebar instead of joining again.'
          : 'You are already in this shared chat.'
      );
    }

    const sub = getCognitoSubFromSession();
    if (!sub) throw new Error('Cognito identity required');
    const displayName = getCurrentSession()?.user?.name || getCurrentSession()?.user?.email || 'User';

    const created = this.deps.createJoinedSession({
      title: 'Shared chat',
      roomId,
      role: 'member',
    });

    await this.connectRoom({
      sessionId: created.id,
      roomId,
      role: 'member',
      ownerBootstrap: false,
      seedFromLocal: false,
      displayName,
      sub,
    });

    this.deps.updateSessionCollab(created.id, { collabRoomId: roomId, collabRole: 'member' });
    return { sessionId: created.id, roomId };
  }

  async reconnectIfNeeded(sessionId: string): Promise<void> {
    if (this.roomsBySession.has(sessionId)) return;
    const session = this.deps.getSession(sessionId);
    if (!session?.collabRoomId) return;
    const sub = getCognitoSubFromSession();
    if (!sub) return;
    const displayName = getCurrentSession()?.user?.name || 'User';
    const role = session.collabRole || 'member';
    await this.connectRoom({
      sessionId,
      roomId: session.collabRoomId,
      role,
      ownerBootstrap: role === 'owner',
      seedFromLocal: true,
      displayName,
      sub,
    });
  }

  private async connectRoom(input: {
    sessionId: string;
    roomId: string;
    role: 'owner' | 'member';
    ownerBootstrap: boolean;
    seedFromLocal: boolean;
    displayName: string;
    sub: string;
  }): Promise<void> {
    this.leaveSession(input.sessionId, { clearDb: false });

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalStateField('user', {
      sub: input.sub,
      name: input.displayName,
      role: input.role,
    });

    if (input.seedFromLocal) {
      const session = this.deps.getSession(input.sessionId);
      if (session) {
        seedCollabMeta(
          doc,
          {
            title: session.title,
            division: session.division,
            hubProjectId: session.hubProjectId,
            hubProjectName: session.hubProjectName,
            launchpadProjectId: session.launchpadProjectId,
            launchpadProjectName: session.launchpadProjectName,
            createdBySub: input.sub,
            createdAt: session.createdAt,
          },
          { sub: input.sub, displayName: input.displayName }
        );
        for (const message of this.deps.getMessages(input.sessionId)) {
          if (message.localStatus === 'queued' || message.localStatus === 'cancelled') continue;
          commitCollabMessage(doc, messageToCollabPortable(message));
        }
      }
    } else {
      upsertCollabMember(doc, input.sub, {
        displayName: input.displayName,
        role: 'member',
        joinedAt: Date.now(),
      });
    }

    const params = new URLSearchParams();
    params.set('roomId', input.roomId);
    const auth = getCurrentSession();
    const token = auth?.idToken || auth?.accessToken || '';
    params.set('token', token);
    if (input.ownerBootstrap) {
      params.set('owner', '1');
    }

    const url = `${backendWsBase()}/collab/ws?${params.toString()}`;

    const rt: RoomRuntime = {
      sessionId: input.sessionId,
      roomId: input.roomId,
      role: input.role,
      inviteToken: input.roomId,
      doc,
      awareness,
      provider: null as unknown as CollabWsProvider,
      connection: 'connecting',
      peersOnline: false,
      applyingRemote: false,
      leaseRefreshTimer: null,
      knownMessageIds: new Set(listOrderedMessages(doc).map((m) => m.id)),
    };

    const provider = new CollabWsProvider({
      url,
      doc,
      awareness,
      onStatus: (status) => {
        rt.connection = status;
        this.emitState(input.sessionId);
      },
    });
    rt.provider = provider;

    // Observe remote message commits
    const { messages, messageOrder, turnLease, members } = getCollabMaps(doc);
    const onRemoteChange = () => {
      if (rt.applyingRemote) return;
      this.projectRemoteMessages(rt);
      this.emitState(input.sessionId);
    };
    messages.observe(onRemoteChange);
    messageOrder.observe(onRemoteChange);
    turnLease.observe(() => this.emitState(input.sessionId));
    members.observe(() => this.emitState(input.sessionId));

    awareness.on('change', () => {
      const states = awareness.getStates();
      const wasPeersOnline = rt.peersOnline;
      rt.peersOnline = states.size > 1;

      const onlineSubs = new Set<string>();
      for (const state of states.values()) {
        const user = state?.user as { sub?: string } | undefined;
        if (user?.sub) onlineSubs.add(user.sub);
      }
      // Always count ourselves as online for lease checks
      onlineSubs.add(input.sub);

      const cleared = clearLeaseIfHolderOffline(doc, onlineSubs);
      if (cleared || !readTurnLease(doc)) {
        tryAcquireLease(doc, { sub: input.sub, displayName: input.displayName });
      }

      // New peer appeared — pull latest transcript
      if (rt.peersOnline && !wasPeersOnline) {
        rt.provider.requestSync();
      }

      this.emitAwareness(input.sessionId);
      this.emitState(input.sessionId);
    });

    this.roomsBySession.set(input.sessionId, rt);
    this.sessionByRoom.set(input.roomId, input.sessionId);

    // Anyone connecting acquires if lease is free (owner and member)
    tryAcquireLease(doc, { sub: input.sub, displayName: input.displayName });
    if (canPromptWithLease(doc, input.sub)) {
      this.startLeaseRefresh(rt, input.sub);
    }

    this.emitState(input.sessionId);
    log(`[Collab] connected session=${input.sessionId} room=${input.roomId} role=${input.role}`);
  }

  private projectRemoteMessages(rt: RoomRuntime): void {
    const ordered = listOrderedMessages(rt.doc);
    for (const portable of ordered) {
      if (rt.knownMessageIds.has(portable.id)) continue;
      rt.knownMessageIds.add(portable.id);
      rt.applyingRemote = true;
      try {
        const message: Message = {
          id: portable.id,
          sessionId: rt.sessionId,
          role: portable.role,
          content: portable.content,
          timestamp: portable.timestamp,
          api: portable.api,
          provider: portable.provider,
          model: portable.model,
          tokenUsage: portable.tokenUsage,
          executionTimeMs: portable.executionTimeMs,
        };
        this.deps.saveMessage(message);
      } catch (error) {
        logError('[Collab] Failed to project remote message:', error);
      } finally {
        rt.applyingRemote = false;
      }
    }

    // Update title from meta if present
    const title = getCollabMaps(rt.doc).meta.get('title');
    if (typeof title === 'string' && title.trim()) {
      const session = this.deps.getSession(rt.sessionId);
      if (session && session.title !== title) {
        session.title = title;
        this.deps.emitSessionUpdate?.(session);
      }
    }
  }

  /** Called after local saveMessage for shared sessions (finished turns only). */
  onLocalMessageSaved(sessionId: string, message: Message): void {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt || rt.applyingRemote) return;
    if (message.localStatus === 'queued' || message.localStatus === 'cancelled') return;
    // Skip empty assistant shells used for live streaming.
    if (message.role === 'assistant') {
      const text = message.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const hasSubstance =
        text.trim().length > 0 ||
        message.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
      if (!hasSubstance) return;
    }
    const portable = messageToCollabPortable(message);
    if (commitCollabMessage(rt.doc, portable)) {
      rt.knownMessageIds.add(message.id);
    }
  }

  /** Accumulate stream.partial deltas into awareness for spectators. */
  onStreamPartial(sessionId: string, delta: string): void {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) return;
    const prev = (rt.awareness.getLocalState()?.partial as { text?: string } | undefined)?.text || '';
    this.setStreamingPartial(sessionId, prev + delta);
  }

  setStreamingPartial(sessionId: string, text: string | null): void {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) return;
    const name = getCurrentSession()?.user?.name || 'User';
    if (text == null || text === '') {
      rt.awareness.setLocalStateField('partial', null);
    } else {
      rt.awareness.setLocalStateField('partial', { text, fromName: name });
    }
  }

  acquireTurn(sessionId: string): CollabRoomState | null {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) throw new Error('Not connected to shared room');
    const sub = getCognitoSubFromSession();
    if (!sub) throw new Error('Authentication required');
    const displayName = getCurrentSession()?.user?.name || 'User';
    const result = tryAcquireLease(rt.doc, { sub, displayName });
    if (!result.ok) {
      throw new Error(
        `Turn held by ${result.holder?.holderName || 'someone else'}. Wait until they finish or the lease expires.`
      );
    }
    this.startLeaseRefresh(rt, sub);
    this.emitState(sessionId);
    return this.getState(sessionId);
  }

  releaseTurn(sessionId: string): CollabRoomState | null {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) return null;
    const sub = getCognitoSubFromSession();
    if (sub) releaseLeaseIfHolder(rt.doc, sub);
    this.stopLeaseRefresh(rt);
    this.setStreamingPartial(sessionId, null);
    this.emitState(sessionId);
    return this.getState(sessionId);
  }

  onAgentRunStart(sessionId: string): void {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) return;
    const sub = getCognitoSubFromSession();
    if (!sub) return;
    refreshLease(rt.doc, sub, { runId: randomUUID() });
    this.startLeaseRefresh(rt, sub);
  }

  onAgentRunEnd(sessionId: string): void {
    const rt = this.roomsBySession.get(sessionId);
    if (!rt) return;
    this.setStreamingPartial(sessionId, null);
    // Keep lease so owner can send follow-ups; just stop aggressive refresh
    this.stopLeaseRefresh(rt);
    const sub = getCognitoSubFromSession();
    if (sub) refreshLease(rt.doc, sub, { runId: null });
    this.emitState(sessionId);
  }

  private startLeaseRefresh(rt: RoomRuntime, sub: string): void {
    this.stopLeaseRefresh(rt);
    rt.leaseRefreshTimer = setInterval(() => {
      refreshLease(rt.doc, sub);
    }, 30_000);
  }

  private stopLeaseRefresh(rt: RoomRuntime): void {
    if (rt.leaseRefreshTimer) {
      clearInterval(rt.leaseRefreshTimer);
      rt.leaseRefreshTimer = null;
    }
  }

  leaveSession(sessionId: string, options?: { clearDb?: boolean }): void {
    const rt = this.roomsBySession.get(sessionId);
    if (rt) {
      this.stopLeaseRefresh(rt);
      const sub = getCognitoSubFromSession();
      if (sub) releaseLeaseIfHolder(rt.doc, sub);
      rt.provider.destroy();
      rt.doc.destroy();
      this.roomsBySession.delete(sessionId);
      this.sessionByRoom.delete(rt.roomId);
    }
    if (options?.clearDb) {
      this.deps.updateSessionCollab(sessionId, { collabRoomId: null, collabRole: null });
    }
    this.emitState(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.roomsBySession.keys()]) {
      this.leaveSession(sessionId, { clearDb: false });
    }
  }
}

/** Exported for projecting portable messages in tests. */
export function portableToMessage(
  portable: CollabPortableMessage,
  sessionId: string
): Message {
  return {
    id: portable.id,
    sessionId,
    role: portable.role,
    content: portable.content,
    timestamp: portable.timestamp,
    api: portable.api,
    provider: portable.provider,
    model: portable.model,
    tokenUsage: portable.tokenUsage,
    executionTimeMs: portable.executionTimeMs,
  };
}
