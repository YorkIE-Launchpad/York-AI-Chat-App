import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  CollabSyncService,
  type CollabRoomRuntimeForTests,
} from '../src/main/collab/collab-sync-service';
import { collectChatDocumentPaths } from '../src/main/collab/collab-shared-docs';
import { addCollabSharedDoc, listCollabSharedDocs } from '../src/shared/collab/shared-session-doc';
import type { Message, Session } from '../src/renderer/types';

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

vi.mock('../src/main/shared-docs/shared-docs-service', () => ({
  sharedDocsService: {},
  workspaceRelativePath: (_root: string, path: string) => path,
}));

vi.mock('../src/main/shared-docs/shared-doc-link-store', () => ({
  getSharedDocLink: () => undefined,
  getSharedDocLinkByLocalPath: () => undefined,
  listSharedDocLinksForSession: () => [],
}));

function writeMessage(id: string, name: string, path: string): Message {
  return {
    id,
    sessionId: 'session-shared',
    role: 'assistant',
    content: [{ type: 'tool_use', id: `tool-${id}`, name, input: { path, content: 'x' } }],
    timestamp: Date.now(),
  };
}

function installRoom(service: CollabSyncService): CollabRoomRuntimeForTests {
  const doc = new Y.Doc();
  const rt: CollabRoomRuntimeForTests = {
    sessionId: 'session-shared',
    roomId: 'room_test',
    role: 'owner',
    inviteToken: 'room_test',
    doc,
    awareness: new awarenessProtocol.Awareness(doc),
    provider: { destroy: vi.fn(), requestSync: vi.fn() } as never,
    connection: 'connected',
    peersOnline: true,
    applyingRemote: false,
    leaseRefreshTimer: null,
    knownFingerprints: new Map(),
  };
  service.installRoomForTests(rt);
  return rt;
}

describe('collectChatDocumentPaths', () => {
  it('returns unique HTML and Markdown paths from file tool calls', () => {
    const paths = collectChatDocumentPaths([
      writeMessage('1', 'write', 'outputs/report.html'),
      writeMessage('2', 'edit', 'outputs/report.html'),
      writeMessage('3', 'Write', 'notes/plan.md'),
      writeMessage('4', 'write', 'src/index.ts'),
      writeMessage('5', 'bash', 'outputs/other.html'),
    ]);
    expect(paths).toEqual(['outputs/report.html', 'notes/plan.md']);
  });
});

describe('shared docs map', () => {
  it('dedupes entries by docId and lists them in share order', () => {
    const doc = new Y.Doc();
    const base = { title: 'A', kind: 'html' as const, sharedBySub: 'u1' };
    expect(addCollabSharedDoc(doc, { ...base, docId: 'b', inviteToken: 't-b', sharedAt: 2 })).toBe(
      true
    );
    expect(addCollabSharedDoc(doc, { ...base, docId: 'a', inviteToken: 't-a', sharedAt: 1 })).toBe(
      true
    );
    expect(
      addCollabSharedDoc(doc, { ...base, docId: 'a', inviteToken: 'other', sharedAt: 3 })
    ).toBe(false);
    expect(listCollabSharedDocs(doc).map((entry) => entry.inviteToken)).toEqual(['t-a', 't-b']);
  });
});

describe('CollabSyncService document auto-share', () => {
  it('publishes documents written during a local run once the run ends', async () => {
    const publishDocuments = vi.fn(async (input: { paths: string[] }) =>
      input.paths.map((path, index) => ({
        docId: `doc-${index}`,
        inviteToken: `invite-${index}`,
        title: path,
        kind: 'html' as const,
      }))
    );
    const service = new CollabSyncService({
      getSession: () => ({ id: 'session-shared', cwd: '/work' }) as Session,
      listSessions: () => [],
      getMessages: () => [],
      saveMessage: () => undefined,
      emitStreamMessage: () => undefined,
      createJoinedSession: () => {
        throw new Error('unused');
      },
      updateSessionCollab: () => undefined,
      getWindow: () => null,
      collectDocumentPaths: collectChatDocumentPaths,
      publishDocuments,
    });
    const rt = installRoom(service);

    service.onLocalMessageSaved('session-shared', writeMessage('m1', 'write', 'out/a.html'));
    expect(publishDocuments).not.toHaveBeenCalled();

    service.onAgentRunEnd('session-shared');
    await vi.waitFor(() => expect(listCollabSharedDocs(rt.doc)).toHaveLength(1));

    expect(publishDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-shared', cwd: '/work', paths: ['out/a.html'] })
    );
    expect(listCollabSharedDocs(rt.doc)[0]).toMatchObject({
      docId: 'doc-0',
      inviteToken: 'invite-0',
    });
  });
});
