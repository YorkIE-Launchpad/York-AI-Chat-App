import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  CollabSyncService,
  type CollabRoomRuntimeForTests,
} from '../src/main/collab/collab-sync-service';
import {
  collabMessageFingerprint,
  commitCollabMessage,
  messageToCollabPortable,
  upsertCollabMessage,
} from '../src/shared/collab/shared-session-doc';
import type { Message } from '../src/renderer/types';

vi.mock('../src/main/auth/session', () => ({
  getCurrentSession: () => ({
    user: { name: 'Local User', email: 'local@york.ie' },
    idToken: null,
    accessToken: null,
  }),
  ensureAuthenticatedSession: async () => ({}),
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

function sampleMessage(id: string, text: string): Message {
  return {
    id,
    sessionId: 'session-shared',
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

describe('CollabSyncService remote projection', () => {
  it('emits stream.message once for a new remote message and does not echo into Yjs', () => {
    const saveMessage = vi.fn();
    const emitStreamMessage = vi.fn();
    const onLocalEcho = vi.fn();

    const service = new CollabSyncService({
      getSession: () => null,
      listSessions: () => [],
      getMessages: () => [],
      saveMessage: (message) => {
        saveMessage(message);
        // Mimic SessionManager collab hook calling back into the service.
        service.onLocalMessageSaved(message.sessionId, message);
        onLocalEcho(message.id);
      },
      emitStreamMessage,
      createJoinedSession: () => {
        throw new Error('unused');
      },
      updateSessionCollab: () => undefined,
      getWindow: () => null,
    });

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const provider = {
      destroy: vi.fn(),
      requestSync: vi.fn(),
    };

    const rt: CollabRoomRuntimeForTests = {
      sessionId: 'session-shared',
      roomId: 'room_test',
      role: 'member',
      inviteToken: 'room_test',
      doc,
      awareness,
      provider: provider as never,
      connection: 'connected',
      peersOnline: true,
      applyingRemote: false,
      leaseRefreshTimer: null,
      knownFingerprints: new Map(),
    };
    service.installRoomForTests(rt);

    const portable = messageToCollabPortable(sampleMessage('remote-1', 'hello from peer'));
    expect(commitCollabMessage(doc, portable)).toBe(true);

    service.flushRemoteProjectionForTests('session-shared');

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(emitStreamMessage).toHaveBeenCalledTimes(1);
    expect(emitStreamMessage.mock.calls[0]?.[0]).toMatchObject({
      id: 'remote-1',
      sessionId: 'session-shared',
    });
    // applyingRemote must suppress onLocalMessageSaved re-commit (still "called" via
    // our mock saveMessage wiring, but no second Yjs insert / known-id churn).
    expect(onLocalEcho).toHaveBeenCalledTimes(1);
    expect(rt.knownFingerprints.has('remote-1')).toBe(true);

    // Second flush is a no-op (already projected).
    service.flushRemoteProjectionForTests('session-shared');
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(emitStreamMessage).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('projects content edits onto an existing shared message', () => {
    const updateStoredMessage = vi.fn();
    const service = new CollabSyncService({
      getSession: () => null,
      listSessions: () => [],
      getMessages: () => [],
      saveMessage: vi.fn(),
      updateStoredMessage,
      emitStreamMessage: vi.fn(),
      createJoinedSession: () => {
        throw new Error('unused');
      },
      updateSessionCollab: () => undefined,
      getWindow: () => null,
    });

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const original = messageToCollabPortable(sampleMessage('remote-1', 'first'));
    commitCollabMessage(doc, original);

    const rt: CollabRoomRuntimeForTests = {
      sessionId: 'session-shared',
      roomId: 'room_test',
      role: 'member',
      doc,
      awareness,
      provider: { destroy: vi.fn(), requestSync: vi.fn() } as never,
      connection: 'connected',
      peersOnline: true,
      applyingRemote: false,
      leaseRefreshTimer: null,
      knownFingerprints: new Map([[original.id, collabMessageFingerprint(original)]]),
    };
    service.installRoomForTests(rt);

    upsertCollabMessage(doc, messageToCollabPortable(sampleMessage('remote-1', 'revised')));
    service.flushRemoteProjectionForTests('session-shared');

    expect(updateStoredMessage).toHaveBeenCalledTimes(1);
    expect(updateStoredMessage.mock.calls[0]?.[0]).toMatchObject({
      id: 'remote-1',
      content: [{ type: 'text', text: 'revised' }],
    });

    service.dispose();
  });
});
