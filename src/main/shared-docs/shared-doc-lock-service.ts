/**
 * Per-document edit lock over the existing Yjs collab WebSocket relay.
 * One Y.Doc per shared doc id (roomId = docId); turnLease coordinates exclusive edit access.
 */
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { BrowserWindow } from 'electron';
import { resolveBackendUrl } from '../../shared/backend-config';
import {
  clearLeaseIfHolderOffline,
  getCollabMaps,
  isLeaseHeldByOther,
  readTurnLease,
  refreshLease,
  releaseLeaseIfHolder,
  tryAcquireLease,
} from '../../shared/collab/shared-session-doc';
import type { SharedDocLockState } from '../../shared/shared-docs/lock-types';
import { SHARED_DOC_LOCK_HELD } from '../../shared/shared-docs/lock-types';
import { sharedDocAccessCanEdit } from '../../shared/shared-docs/types';
import { CollabWsProvider, type CollabWsStatus } from '../collab/collab-ws-provider';
import { getCognitoSubFromSession } from '../collab/collab-sync-service';
import { getCurrentSession, ensureAuthenticatedSession } from '../auth/session';
import { getBackendAuthHeaders } from '../config/backend-auth';
import { log } from '../utils/logger';

interface DocRoomRuntime {
  docId: string;
  roomId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  provider: CollabWsProvider;
  connection: CollabWsStatus;
  watchers: number;
  canEditWatchers: number;
  leaseRefreshTimer: ReturnType<typeof setInterval> | null;
  editIdleTimer: ReturnType<typeof setTimeout> | null;
  localSub: string;
  displayName: string;
}

/** The edit lock is held while edits keep arriving and released after this much quiet. */
const EDIT_LOCK_IDLE_MS = 2 * 60_000;

function backendWsBase(): string {
  const http = resolveBackendUrl().replace(/\/$/, '');
  if (http.startsWith('https://')) return `wss://${http.slice('https://'.length)}`;
  if (http.startsWith('http://')) return `ws://${http.slice('http://'.length)}`;
  return `ws://${http}`;
}

function isValidDocRoomId(docId: string): boolean {
  const trimmed = docId.trim();
  return /^[a-zA-Z0-9_-]{8,64}$/.test(trimmed);
}

export class SharedDocLockService {
  private roomsByDocId = new Map<string, DocRoomRuntime>();
  private preferHttpRelay = false;

  constructor(private getWindow: () => BrowserWindow | null) {}

  private buildState(rt: DocRoomRuntime): SharedDocLockState {
    const lease = readTurnLease(rt.doc);
    const holderIsOther = isLeaseHeldByOther(rt.doc, rt.localSub);
    return {
      docId: rt.docId,
      connection: rt.connection,
      lease,
      localSub: rt.localSub,
      canEdit: rt.canEditWatchers > 0,
      holderIsOther,
      holderName: holderIsOther ? lease?.holderName : undefined,
    };
  }

  getState(docId: string): SharedDocLockState | null {
    const rt = this.roomsByDocId.get(docId.trim());
    if (!rt) return null;
    return this.buildState(rt);
  }

  getStatesForDocIds(docIds: string[]): SharedDocLockState[] {
    const out: SharedDocLockState[] = [];
    for (const id of docIds) {
      const state = this.getState(id);
      if (state) out.push(state);
    }
    return out;
  }

  private emitState(docId: string): void {
    const rt = this.roomsByDocId.get(docId);
    if (!rt) return;
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('sharedDocLock:state', this.buildState(rt));
  }

  private startLeaseRefresh(rt: DocRoomRuntime): void {
    this.stopLeaseRefresh(rt);
    rt.leaseRefreshTimer = setInterval(() => {
      refreshLease(rt.doc, rt.localSub);
    }, 30_000);
  }

  private stopLeaseRefresh(rt: DocRoomRuntime): void {
    if (rt.leaseRefreshTimer) {
      clearInterval(rt.leaseRefreshTimer);
      rt.leaseRefreshTimer = null;
    }
    if (rt.editIdleTimer) {
      clearTimeout(rt.editIdleTimer);
      rt.editIdleTimer = null;
    }
  }

  private scheduleEditIdleRelease(rt: DocRoomRuntime): void {
    if (rt.editIdleTimer) clearTimeout(rt.editIdleTimer);
    rt.editIdleTimer = setTimeout(() => {
      rt.editIdleTimer = null;
      if (this.roomsByDocId.get(rt.docId) !== rt) return;
      this.releaseDoc(rt.docId);
    }, EDIT_LOCK_IDLE_MS);
  }

  private async ensureConnected(docId: string): Promise<DocRoomRuntime> {
    const trimmed = docId.trim();
    if (!isValidDocRoomId(trimmed)) {
      throw new Error('Invalid shared document id');
    }
    const existing = this.roomsByDocId.get(trimmed);
    if (existing) return existing;

    await ensureAuthenticatedSession();
    const sub = getCognitoSubFromSession();
    if (!sub) throw new Error('Authentication required');
    const displayName =
      getCurrentSession()?.user?.name || getCurrentSession()?.user?.email || 'User';

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalStateField('user', { sub, name: displayName });

    const params = new URLSearchParams();
    params.set('roomId', trimmed);
    const auth = getCurrentSession();
    const token = auth?.idToken || auth?.accessToken || '';
    params.set('token', token);
    params.set('owner', '1');

    const url = `${backendWsBase()}/collab/ws?${params.toString()}`;

    const rt: DocRoomRuntime = {
      docId: trimmed,
      roomId: trimmed,
      doc,
      awareness,
      provider: null as unknown as CollabWsProvider,
      connection: 'connecting',
      watchers: 0,
      canEditWatchers: 0,
      leaseRefreshTimer: null,
      editIdleTimer: null,
      localSub: sub,
      displayName,
    };

    const provider = new CollabWsProvider({
      url,
      doc,
      awareness,
      onStatus: (status) => {
        rt.connection = status;
        this.emitState(trimmed);
      },
      httpUrl: `${resolveBackendUrl().replace(/\/$/, '')}/collab/rooms/${encodeURIComponent(trimmed)}/frames`,
      getHttpHeaders: () => getBackendAuthHeaders(),
      forceHttp: this.preferHttpRelay,
      onTransport: (transport) => {
        if (transport === 'http') this.preferHttpRelay = true;
      },
    });
    rt.provider = provider;

    const { turnLease } = getCollabMaps(doc);
    turnLease.observe(() => this.emitState(trimmed));

    awareness.on('change', () => {
      const states = awareness.getStates();
      const onlineSubs = new Set<string>();
      for (const state of states.values()) {
        const user = state?.user as { sub?: string } | undefined;
        if (user?.sub) onlineSubs.add(user.sub);
      }
      onlineSubs.add(rt.localSub);
      clearLeaseIfHolderOffline(doc, onlineSubs);
      this.emitState(trimmed);
    });

    this.roomsByDocId.set(trimmed, rt);
    log(`[SharedDocLock] connected doc=${trimmed}`);
    return rt;
  }

  async watchDoc(docId: string, options: { canEdit: boolean }): Promise<SharedDocLockState> {
    const rt = await this.ensureConnected(docId);
    rt.watchers += 1;
    if (options.canEdit) {
      rt.canEditWatchers += 1;
    }
    this.emitState(rt.docId);
    return this.buildState(rt);
  }

  unwatchDoc(docId: string, options: { canEdit: boolean }): void {
    const trimmed = docId.trim();
    const rt = this.roomsByDocId.get(trimmed);
    if (!rt) return;
    rt.watchers = Math.max(0, rt.watchers - 1);
    if (options.canEdit) {
      rt.canEditWatchers = Math.max(0, rt.canEditWatchers - 1);
    }
    if (rt.watchers <= 0) {
      this.teardownRoom(trimmed);
      return;
    }
    if (rt.canEditWatchers <= 0) {
      releaseLeaseIfHolder(rt.doc, rt.localSub);
      this.stopLeaseRefresh(rt);
    }
    this.emitState(trimmed);
  }

  private teardownRoom(docId: string): void {
    const rt = this.roomsByDocId.get(docId);
    if (!rt) return;
    this.stopLeaseRefresh(rt);
    releaseLeaseIfHolder(rt.doc, rt.localSub);
    rt.provider.destroy();
    rt.doc.destroy();
    this.roomsByDocId.delete(docId);
    log(`[SharedDocLock] disconnected doc=${docId}`);
  }

  async assertCanEditDoc(docId: string): Promise<void> {
    const rt = await this.ensureConnected(docId);
    if (isLeaseHeldByOther(rt.doc, rt.localSub)) {
      const lease = readTurnLease(rt.doc);
      const err = new Error(
        `${lease?.holderName || 'Someone else'} is working on this document. Wait until they finish or the lock expires.`
      );
      (err as Error & { code?: string }).code = SHARED_DOC_LOCK_HELD;
      throw err;
    }
    const result = tryAcquireLease(rt.doc, { sub: rt.localSub, displayName: rt.displayName });
    if (!result.ok) {
      const err = new Error(
        `${result.holder?.holderName || 'Someone else'} is working on this document. Wait until they finish or the lock expires.`
      );
      (err as Error & { code?: string }).code = SHARED_DOC_LOCK_HELD;
      throw err;
    }
    this.startLeaseRefresh(rt);
    this.scheduleEditIdleRelease(rt);
    this.emitState(rt.docId);
  }

  releaseDoc(docId: string): SharedDocLockState | null {
    const rt = this.roomsByDocId.get(docId.trim());
    if (!rt) return null;
    releaseLeaseIfHolder(rt.doc, rt.localSub);
    this.stopLeaseRefresh(rt);
    this.emitState(rt.docId);
    return this.buildState(rt);
  }

  async acquireDocAsync(docId: string): Promise<SharedDocLockState> {
    await this.assertCanEditDoc(docId);
    const state = this.getState(docId);
    if (!state) throw new Error('Not connected');
    return state;
  }

  dispose(): void {
    for (const docId of [...this.roomsByDocId.keys()]) {
      this.teardownRoom(docId);
    }
  }
}

let sharedDocLockService: SharedDocLockService | null = null;

export function getSharedDocLockService(): SharedDocLockService | null {
  return sharedDocLockService;
}

export function setSharedDocLockService(service: SharedDocLockService | null): void {
  sharedDocLockService = service;
}

export async function assertCanEditSharedDoc(
  docId: string,
  permission: import('../../shared/shared-docs/types').SharedDocWithAccess['permission'] | string
): Promise<void> {
  if (!sharedDocAccessCanEdit(permission)) {
    throw new Error('Read-only shared document');
  }
  const svc = getSharedDocLockService();
  if (!svc) {
    throw new Error('Shared document lock service unavailable');
  }
  await svc.assertCanEditDoc(docId);
}
