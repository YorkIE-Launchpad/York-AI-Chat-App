import { describe, expect, it, vi } from 'vitest';
import type { DatabaseInstance } from '../src/main/db/database';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-session-manager-crud-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults || {}) };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = { ...this.store, ...key };
    }
  }
  return { default: MockStore };
});

vi.mock('../src/main/agent/agent-runner', () => ({
  CoworkAgentRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

import { SessionManager } from '../src/main/session/session-manager';

// Shared minimal DB factory used across tests
function makeDb(overrides: Partial<DatabaseInstance> = {}): DatabaseInstance {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(() => null),
      getAll: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    messages: {
      create: vi.fn(),
      getBySessionId: vi.fn(() => []),
      delete: vi.fn(),
      deleteBySessionId: vi.fn(),
    },
    traceSteps: {
      create: vi.fn(),
      update: vi.fn(),
      getBySessionId: vi.fn(() => []),
      deleteBySessionId: vi.fn(),
    },
    raw: {
      transaction: (fn: () => void) => fn,
    },
    ...overrides,
  } as unknown as DatabaseInstance;
}

// ------------------------------------------------------------------
// listSessions
// ------------------------------------------------------------------
describe('SessionManager.listSessions', () => {
  it('returns empty array when database is empty', () => {
    const db = makeDb();
    const manager = new SessionManager(db, vi.fn());
    expect(manager.listSessions()).toEqual([]);
    expect(db.sessions.getAll).toHaveBeenCalledTimes(1);
  });

  it('maps database rows to Session objects', () => {
    const row = {
      id: 's1',
      title: 'My Session',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: '/tmp/workspace',
      mounted_paths: JSON.stringify([{ virtual: '/mnt/workspace', real: '/tmp/workspace' }]),
      allowed_tools: JSON.stringify(['read', 'write']),
      memory_enabled: 0,
      model: 'claude-3-5-sonnet',
      created_at: 1000,
      updated_at: 2000,
    };
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => null),
        getAll: vi.fn(() => [row]),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, vi.fn());
    const sessions = manager.listSessions();

    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe('s1');
    expect(s.title).toBe('My Session');
    expect(s.cwd).toBe('/tmp/workspace');
    expect(s.mountedPaths).toEqual([{ virtual: '/mnt/workspace', real: '/tmp/workspace' }]);
    expect(s.allowedTools).toEqual(['read', 'write']);
    expect(s.memoryEnabled).toBe(false);
    expect(s.model).toBe('claude-3-5-sonnet');
    expect(s.pinned).toBe(false);
    expect(s.createdAt).toBe(1000);
    expect(s.updatedAt).toBe(2000);
  });

  it('maps pinned sessions from database rows', () => {
    const row = {
      id: 's-pinned',
      title: 'Pinned Session',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: null,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 0,
      model: null,
      pinned: 1,
      created_at: 1000,
      updated_at: 2000,
    };
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => null),
        getAll: vi.fn(() => [row]),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, vi.fn());
    const [s] = manager.listSessions();
    expect(s.pinned).toBe(true);
  });

  it('falls back to empty arrays when mounted_paths or allowed_tools JSON is malformed', () => {
    const row = {
      id: 's2',
      title: 'Broken JSON',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: null,
      mounted_paths: '{{{broken',
      allowed_tools: '[unclosed',
      memory_enabled: 0,
      model: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => null),
        getAll: vi.fn(() => [row]),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, vi.fn());
    const [s] = manager.listSessions();

    expect(s.mountedPaths).toEqual([]);
    expect(s.allowedTools).toEqual([]);
  });
});

// ------------------------------------------------------------------
// getMessages — content normalization
// ------------------------------------------------------------------
describe('SessionManager.getMessages content normalization', () => {
  it('parses a JSON array content correctly', () => {
    const db = makeDb({
      messages: {
        create: vi.fn(),
        delete: vi.fn(),
        deleteBySessionId: vi.fn(),
        getBySessionId: vi.fn(() => [
          {
            id: 'm1',
            session_id: 's1',
            role: 'user',
            content: JSON.stringify([{ type: 'text', text: 'hello' }]),
            timestamp: 1,
            token_usage: null,
            execution_time_ms: null,
          },
        ]),
      } as unknown,
    });

    const manager = new SessionManager(db, vi.fn());
    const messages = manager.getMessages('s1');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('wraps a single JSON object content in an array', () => {
    const db = makeDb({
      messages: {
        create: vi.fn(),
        delete: vi.fn(),
        deleteBySessionId: vi.fn(),
        getBySessionId: vi.fn(() => [
          {
            id: 'm2',
            session_id: 's1',
            role: 'user',
            content: JSON.stringify({ type: 'text', text: 'single block' }),
            timestamp: 2,
            token_usage: null,
            execution_time_ms: null,
          },
        ]),
      } as unknown,
    });

    const manager = new SessionManager(db, vi.fn());
    const [msg] = manager.getMessages('s1');
    expect(msg.content).toEqual([{ type: 'text', text: 'single block' }]);
  });

  it('wraps a plain JSON string as a text content block', () => {
    const db = makeDb({
      messages: {
        create: vi.fn(),
        delete: vi.fn(),
        deleteBySessionId: vi.fn(),
        getBySessionId: vi.fn(() => [
          {
            id: 'm3',
            session_id: 's1',
            role: 'assistant',
            content: JSON.stringify('plain string content'),
            timestamp: 3,
            token_usage: null,
            execution_time_ms: null,
          },
        ]),
      } as unknown,
    });

    const manager = new SessionManager(db, vi.fn());
    const [msg] = manager.getMessages('s1');
    expect(msg.content).toEqual([{ type: 'text', text: 'plain string content' }]);
  });

  it('falls back to raw string as text block when JSON parse fails', () => {
    const db = makeDb({
      messages: {
        create: vi.fn(),
        delete: vi.fn(),
        deleteBySessionId: vi.fn(),
        getBySessionId: vi.fn(() => [
          {
            id: 'm4',
            session_id: 's1',
            role: 'assistant',
            content: 'not valid json {{{',
            timestamp: 4,
            token_usage: null,
            execution_time_ms: null,
          },
        ]),
      } as unknown,
    });

    const manager = new SessionManager(db, vi.fn());
    const [msg] = manager.getMessages('s1');
    expect(msg.content).toEqual([{ type: 'text', text: 'not valid json {{{' }]);
  });
});

// ------------------------------------------------------------------
// handlePermissionResponse
// ------------------------------------------------------------------
describe('SessionManager.handlePermissionResponse', () => {
  it('resolves the pending permission promise with the given result', async () => {
    const db = makeDb();
    const sendToRenderer = vi.fn();
    const manager = new SessionManager(db, sendToRenderer);

    // Inject a fake pending permission via requestPermission
    const permissionPromise = manager.requestPermission('s1', 'tool-1', 'bash', { command: 'ls' });

    // Synchronously resolve it
    manager.handlePermissionResponse('tool-1', 'allow');

    const result = await permissionPromise;
    expect(result).toBe('allow');
  });

  it('is a no-op when the toolUseId is unknown', () => {
    const db = makeDb();
    const manager = new SessionManager(db, vi.fn());
    // Should not throw
    expect(() => manager.handlePermissionResponse('nonexistent', 'deny')).not.toThrow();
  });
});

// ------------------------------------------------------------------
// handleSudoPasswordResponse
// ------------------------------------------------------------------
describe('SessionManager.handleSudoPasswordResponse', () => {
  it('resolves the pending sudo password promise with the given password', async () => {
    const db = makeDb();
    const sendToRenderer = vi.fn();
    const manager = new SessionManager(db, sendToRenderer);

    const sudoPromise = manager.requestSudoPassword('s1', 'tool-2', 'sudo apt-get update');

    manager.handleSudoPasswordResponse('tool-2', 'secret123');

    const password = await sudoPromise;
    expect(password).toBe('secret123');
  });

  it('is a no-op when the toolUseId is unknown', () => {
    const db = makeDb();
    const manager = new SessionManager(db, vi.fn());
    expect(() => manager.handleSudoPasswordResponse('nonexistent', 'pw')).not.toThrow();
  });
});

// ------------------------------------------------------------------
// setSessionTitle
// ------------------------------------------------------------------
describe('SessionManager.setSessionTitle', () => {
  const existingRow = {
    id: 's1',
    title: 'Old title',
    claude_session_id: null,
    openai_thread_id: null,
    status: 'idle',
    cwd: null,
    mounted_paths: '[]',
    allowed_tools: '[]',
    memory_enabled: 0,
    model: null,
    division: 'general',
    hub_project_id: null,
    hub_project_name: null,
    pinned: 0,
    created_at: 1000,
    updated_at: 2000,
  };

  it('trims title, writes to the database, and emits session.update', () => {
    const update = vi.fn();
    const sendToRenderer = vi.fn();
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => existingRow),
        getAll: vi.fn(() => []),
        update,
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, sendToRenderer);
    const ok = manager.setSessionTitle('s1', '  New title  ');

    expect(ok).toBe(true);
    expect(update).toHaveBeenCalledWith('s1', { title: 'New title' });
    expect(sendToRenderer).toHaveBeenCalledWith({
      type: 'session.update',
      payload: { sessionId: 's1', updates: { title: 'New title' } },
    });
  });

  it('returns false for empty or whitespace-only titles', () => {
    const update = vi.fn();
    const sendToRenderer = vi.fn();
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => existingRow),
        getAll: vi.fn(() => []),
        update,
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, sendToRenderer);
    expect(manager.setSessionTitle('s1', '   ')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('returns false when session is missing', () => {
    const update = vi.fn();
    const sendToRenderer = vi.fn();
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => null),
        getAll: vi.fn(() => []),
        update,
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, sendToRenderer);
    expect(manager.setSessionTitle('missing', 'Hello')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// setSessionPinned
// ------------------------------------------------------------------
describe('SessionManager.setSessionPinned', () => {
  const existingRow = {
    id: 's1',
    title: 'Pinned chat',
    claude_session_id: null,
    openai_thread_id: null,
    status: 'idle',
    cwd: null,
    mounted_paths: '[]',
    allowed_tools: '[]',
    memory_enabled: 0,
    model: null,
    division: 'general',
    hub_project_id: null,
    hub_project_name: null,
    pinned: 0,
    created_at: 1000,
    updated_at: 2000,
  };

  it('writes pinned to the database and emits session.update', () => {
    const update = vi.fn();
    const sendToRenderer = vi.fn();
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => existingRow),
        getAll: vi.fn(() => []),
        update,
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, sendToRenderer);
    const ok = manager.setSessionPinned('s1', true);

    expect(ok).toBe(true);
    expect(update).toHaveBeenCalledWith('s1', { pinned: 1 });
    expect(sendToRenderer).toHaveBeenCalledWith({
      type: 'session.update',
      payload: { sessionId: 's1', updates: { pinned: true } },
    });
  });

  it('unpins by writing pinned: 0', () => {
    const update = vi.fn();
    const sendToRenderer = vi.fn();
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => ({ ...existingRow, pinned: 1 })),
        getAll: vi.fn(() => []),
        update,
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, sendToRenderer);
    const ok = manager.setSessionPinned('s1', false);

    expect(ok).toBe(true);
    expect(update).toHaveBeenCalledWith('s1', { pinned: 0 });
    expect(sendToRenderer).toHaveBeenCalledWith({
      type: 'session.update',
      payload: { sessionId: 's1', updates: { pinned: false } },
    });
  });

  it('returns false and skips write when session is missing', () => {
    const update = vi.fn();
    const sendToRenderer = vi.fn();
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => null),
        getAll: vi.fn(() => []),
        update,
        delete: vi.fn(),
      } as unknown,
    });

    const manager = new SessionManager(db, sendToRenderer);
    const ok = manager.setSessionPinned('missing', true);

    expect(ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(sendToRenderer).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.update' })
    );
  });
});

// ------------------------------------------------------------------
// deleteSession — cache eviction
// ------------------------------------------------------------------
describe('SessionManager.deleteSession cache eviction', () => {
  it('evicts the message cache when a session is deleted', async () => {
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => null),
        getAll: vi.fn(() => []),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
      messages: {
        create: vi.fn(),
        delete: vi.fn(),
        deleteBySessionId: vi.fn(),
        getBySessionId: vi.fn(() => [
          {
            id: 'm1',
            session_id: 's1',
            role: 'user',
            content: JSON.stringify([{ type: 'text', text: 'hi' }]),
            timestamp: 1,
            token_usage: null,
            execution_time_ms: null,
          },
        ]),
      } as unknown,
    });

    const manager = new SessionManager(db, vi.fn());

    // Populate the cache
    manager.getMessages('s1');
    expect(db.messages.getBySessionId).toHaveBeenCalledTimes(1);

    // Delete the session (mocked: no real DB changes)
    await manager.deleteSession('s1');

    // Cache should have been evicted — DB should be hit again on next call
    manager.getMessages('s1');
    expect(db.messages.getBySessionId).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------------------
// Incognito (ephemeral) sessions
// ------------------------------------------------------------------
describe('SessionManager incognito sessions', () => {
  it('starts without persisting to SQLite and disables memory', async () => {
    const sendToRenderer = vi.fn();
    const db = makeDb();
    const manager = new SessionManager(db, sendToRenderer);

    const session = await manager.startSession(
      'Secret',
      'hello',
      undefined,
      undefined,
      undefined,
      undefined,
      { incognito: true }
    );

    expect(session.incognito).toBe(true);
    expect(session.memoryEnabled).toBe(false);
    expect(session.title).toBe('Secret');
    expect(db.sessions.create).not.toHaveBeenCalled();
    expect(manager.isIncognitoSession(session.id)).toBe(true);
    expect(manager.listSessions().some((s) => s.id === session.id)).toBe(true);

    await vi.waitFor(() => {
      expect(sendToRenderer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session.status',
          payload: expect.objectContaining({ sessionId: session.id, status: 'idle' }),
        })
      );
    });

    expect(db.messages.create).not.toHaveBeenCalled();
    expect(db.sessions.update).not.toHaveBeenCalled();
    expect(manager.getMessages(session.id).length).toBeGreaterThan(0);
  });

  it('continues from the in-memory session map', async () => {
    const sendToRenderer = vi.fn();
    const db = makeDb();
    const manager = new SessionManager(db, sendToRenderer);

    const session = await manager.startSession(
      'Incognito',
      'first',
      undefined,
      undefined,
      undefined,
      undefined,
      { incognito: true }
    );

    await vi.waitFor(() => {
      expect(sendToRenderer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session.status',
          payload: expect.objectContaining({ sessionId: session.id, status: 'idle' }),
        })
      );
    });

    await expect(manager.continueSession(session.id, 'second')).resolves.toBeUndefined();

    await vi.waitFor(() => {
      const msgs = manager.getMessages(session.id);
      expect(msgs.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(2);
    });

    expect(db.sessions.create).not.toHaveBeenCalled();
    expect(db.messages.create).not.toHaveBeenCalled();
  });

  it('rejects pin and deletes without touching SQLite', async () => {
    const db = makeDb();
    const manager = new SessionManager(db, vi.fn());

    const session = await manager.startSession(
      'Incognito',
      'hi',
      undefined,
      undefined,
      undefined,
      undefined,
      { incognito: true }
    );

    expect(manager.setSessionPinned(session.id, true)).toBe(false);
    expect(db.sessions.update).not.toHaveBeenCalled();

    await manager.deleteSession(session.id);

    expect(db.sessions.delete).not.toHaveBeenCalled();
    expect(manager.isIncognitoSession(session.id)).toBe(false);
    expect(manager.listSessions().some((s) => s.id === session.id)).toBe(false);
  });
});

describe('SessionManager.createIdleSession', () => {
  it('persists an idle Hub session without enqueueing a prompt', async () => {
    const sendToRenderer = vi.fn();
    const db = makeDb();
    const manager = new SessionManager(db, sendToRenderer);

    const session = await manager.createIdleSession(
      'Matter · Reply to Acme',
      undefined,
      undefined,
      undefined,
      {
        division: 'hub',
      }
    );

    expect(session.title).toBe('Matter · Reply to Acme');
    expect(session.status).toBe('idle');
    expect(session.division).toBe('hub');
    expect(db.sessions.create).toHaveBeenCalledTimes(1);
    expect(manager.getMessages(session.id)).toEqual([]);
    // No agent turn should start from createIdleSession alone
    expect(sendToRenderer).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.status',
        payload: expect.objectContaining({ status: 'running' }),
      })
    );
  });
});

// ------------------------------------------------------------------
// renameSession
// ------------------------------------------------------------------
describe('SessionManager.renameSession', () => {
  function makeSessionDb(existing: { id: string; title: string } | null) {
    return makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => existing),
        getAll: vi.fn(() => []),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });
  }

  it('stores the trimmed title and tells the renderer', () => {
    const db = makeSessionDb({ id: 's1', title: 'Old title' });
    const sendToRenderer = vi.fn();
    const manager = new SessionManager(db, sendToRenderer);

    manager.renameSession('s1', '  Quarterly plan  ');

    expect(db.sessions.update).toHaveBeenCalledWith('s1', { title: 'Quarterly plan' });
    expect(sendToRenderer).toHaveBeenCalledWith({
      type: 'session.update',
      payload: { sessionId: 's1', updates: { title: 'Quarterly plan' } },
    });
  });

  it('rejects a blank title', () => {
    const db = makeSessionDb({ id: 's1', title: 'Old title' });
    const manager = new SessionManager(db, vi.fn());

    expect(() => manager.renameSession('s1', '   ')).toThrow('Session title cannot be empty');
    expect(db.sessions.update).not.toHaveBeenCalled();
  });

  it('rejects a title over the length limit or of the wrong type', () => {
    const db = makeSessionDb({ id: 's1', title: 'Old title' });
    const manager = new SessionManager(db, vi.fn());

    expect(() => manager.renameSession('s1', 'x'.repeat(201))).toThrow(
      'Session title cannot exceed 200 characters'
    );
    expect(() => manager.renameSession('s1', 42 as unknown as string)).toThrow(
      'Session title cannot be empty'
    );
    manager.renameSession('s1', 'x'.repeat(200));
    expect(db.sessions.update).toHaveBeenCalledTimes(1);
  });

  it('rejects a deleted session', () => {
    const db = makeSessionDb(null);
    const sendToRenderer = vi.fn();
    const manager = new SessionManager(db, sendToRenderer);

    expect(() => manager.renameSession('gone', 'New title')).toThrow('Session not found: gone');
    expect(db.sessions.update).not.toHaveBeenCalled();
    expect(sendToRenderer).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.update' })
    );
  });
});

describe('SessionManager.editLastPrompt', () => {
  function messageRow(id: string, role: 'user' | 'assistant', text: string, timestamp: number) {
    return {
      id,
      session_id: 's1',
      role,
      content: JSON.stringify([{ type: 'text', text }]),
      timestamp,
      token_usage: null,
      execution_time_ms: null,
      author_name: null,
      author_sub: null,
    };
  }

  function persistedDb(rows: ReturnType<typeof messageRow>[]) {
    return makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => ({
          id: 's1',
          title: 'Chat',
          status: 'idle',
          cwd: '/tmp',
          mounted_paths: '[]',
          allowed_tools: '[]',
          memory_enabled: 1,
          created_at: 1,
          updated_at: 1,
        })),
        getAll: vi.fn(() => []),
        update: vi.fn(),
        delete: vi.fn(),
      },
      messages: {
        create: vi.fn(),
        getBySessionId: vi.fn(() => rows),
        delete: vi.fn(),
        deleteBySessionId: vi.fn(),
      },
    } as unknown as Partial<DatabaseInstance>);
  }

  function stubEnqueue(manager: SessionManager) {
    const order: string[] = [];
    const clearSdkSession = vi.fn(() => {
      order.push('clear');
    });
    (
      manager as unknown as { agentRunner: { clearSdkSession: () => void } }
    ).agentRunner.clearSdkSession = clearSdkSession;
    const enqueued: Array<{ prompt: string; content: unknown }> = [];
    vi.spyOn(
      manager as unknown as {
        enqueuePrompt: (session: unknown, prompt: string, content?: unknown) => void;
      },
      'enqueuePrompt'
    ).mockImplementation((_session, prompt, content) => {
      order.push('enqueue');
      enqueued.push({ prompt, content });
    });
    return { order, clearSdkSession, enqueued };
  }

  it('drops the last user turn, clears the agent session, and enqueues the edit', async () => {
    const rows = [
      messageRow('u1', 'user', 'first', 1),
      messageRow('a1', 'assistant', 'reply one', 2),
      messageRow('u2', 'user', 'second', 3),
      messageRow('a2', 'assistant', 'reply two', 4),
    ];
    const db = persistedDb(rows);
    const manager = new SessionManager(db, vi.fn());
    const { order, clearSdkSession, enqueued } = stubEnqueue(manager);
    const content = [
      { type: 'text' as const, text: 'second, revised' },
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' },
      },
    ];

    await manager.editLastPrompt('s1', 'second, revised', content);

    expect(db.messages.delete).toHaveBeenCalledTimes(2);
    expect(db.messages.delete).toHaveBeenCalledWith('u2');
    expect(db.messages.delete).toHaveBeenCalledWith('a2');
    expect(manager.getMessages('s1').map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(clearSdkSession).toHaveBeenCalledWith('s1');
    expect(order).toEqual(['clear', 'enqueue']);
    expect(enqueued).toEqual([{ prompt: 'second, revised', content }]);
  });

  it('skips database deletes for an incognito session', async () => {
    const db = makeDb();
    const manager = new SessionManager(db, vi.fn());
    (
      manager as unknown as { ephemeralSessions: Map<string, Record<string, unknown>> }
    ).ephemeralSessions.set('inc', {
      id: 'inc',
      title: 'Incognito',
      status: 'idle',
      incognito: true,
      mountedPaths: [],
      allowedTools: [],
      memoryEnabled: false,
      createdAt: 1,
      updatedAt: 1,
    });
    manager.saveMessage({
      id: 'u1',
      sessionId: 'inc',
      role: 'user',
      content: [{ type: 'text', text: 'secret' }],
      timestamp: 1,
    });
    manager.saveMessage({
      id: 'a1',
      sessionId: 'inc',
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      timestamp: 2,
    });
    const { enqueued } = stubEnqueue(manager);

    await manager.editLastPrompt('inc', 'revised secret');

    expect(db.messages.delete).not.toHaveBeenCalled();
    expect(db.messages.create).not.toHaveBeenCalled();
    expect(manager.getMessages('inc')).toEqual([]);
    expect(enqueued[0]?.prompt).toBe('revised secret');
  });

  it('refuses to rewind a busy session', async () => {
    const db = persistedDb([messageRow('u1', 'user', 'hello', 1)]);
    const manager = new SessionManager(db, vi.fn());
    (manager as unknown as { activeSessions: Map<string, AbortController> }).activeSessions.set(
      's1',
      new AbortController()
    );

    await expect(manager.editLastPrompt('s1', 'changed')).rejects.toThrow('Session is busy');
    expect(db.messages.delete).not.toHaveBeenCalled();
  });

  it('throws when the session does not exist', async () => {
    const manager = new SessionManager(makeDb(), vi.fn());
    await expect(manager.editLastPrompt('missing', 'changed')).rejects.toThrow(
      'Session not found: missing'
    );
  });
});
