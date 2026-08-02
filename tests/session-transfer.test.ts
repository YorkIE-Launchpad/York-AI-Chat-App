import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseInstance } from '../src/main/db/database';
import type { Message, Session, TraceStep } from '../src/renderer/types';

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
    public path = '/tmp/mock-session-transfer-config-store.json';

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
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

import { SessionManager } from '../src/main/session/session-manager';
import {
  buildPortablePayload,
  exportSessionToPath,
  importSessionFromPath,
  sanitizeChatExportFilename,
} from '../src/main/session/session-transfer';

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
      update: vi.fn(),
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

describe('session-transfer helpers', () => {
  it('sanitizes export filenames', () => {
    expect(sanitizeChatExportFilename('Hello / World?')).toBe('Hello-World');
    expect(sanitizeChatExportFilename('   ')).toBe('chat');
  });

  it('builds portable payload without provider resume fields', () => {
    const session: Session = {
      id: 's1',
      title: 'Demo',
      claudeSessionId: 'claude-xyz',
      openaiThreadId: 'thread-xyz',
      status: 'idle',
      cwd: '/tmp/exporter',
      mountedPaths: [],
      allowedTools: ['read'],
      memoryEnabled: true,
      model: 'claude-sonnet',
      division: 'general',
      pinned: true,
      createdAt: 1,
      updatedAt: 2,
    };
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        timestamp: 10,
      },
    ];
    const steps: TraceStep[] = [
      {
        id: 't1',
        type: 'text',
        status: 'completed',
        title: 'Reply',
        timestamp: 11,
      },
    ];
    const payload = buildPortablePayload(session, messages, steps);
    expect(payload.session.title).toBe('Demo');
    expect(payload.session.model).toBe('claude-sonnet');
    expect((payload.session as { id?: string }).id).toBeUndefined();
    expect(payload.messages[0].content[0]).toEqual({ type: 'text', text: 'hi' });
    // Deep clone: mutating payload must not touch live message
    (payload.messages[0].content[0] as { text: string }).text = 'mutated';
    expect((messages[0].content[0] as { text: string }).text).toBe('hi');
  });
});

describe('session-transfer ZIP roundtrip', () => {
  let tempDir: string;
  let workspace: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'york-chat-transfer-'));
    workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(path.join(workspace, '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.tmp', 'notes.txt'), 'attachment-body');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('exports and imports a chat with attachments and remapped ids', async () => {
    const session: Session = {
      id: 'export-session',
      title: 'Handoff Chat',
      status: 'idle',
      cwd: workspace,
      mountedPaths: [],
      allowedTools: ['read', 'write'],
      memoryEnabled: false,
      model: 'gpt-test',
      division: 'hub',
      createdAt: 100,
      updatedAt: 200,
    };
    const messages: Message[] = [
      {
        id: 'old-msg-1',
        sessionId: 'export-session',
        role: 'user',
        content: [
          { type: 'text', text: 'Please review the notes' },
          {
            type: 'file_attachment',
            filename: 'notes.txt',
            relativePath: '.tmp/notes.txt',
            size: 15,
            mimeType: 'text/plain',
          },
        ],
        timestamp: 1000,
      },
      {
        id: 'old-msg-2',
        sessionId: 'export-session',
        role: 'assistant',
        content: [{ type: 'text', text: 'Looks good' }],
        timestamp: 1001,
      },
    ];
    const traceSteps: TraceStep[] = [
      {
        id: 'old-trace',
        type: 'text',
        status: 'completed',
        title: 'Looks good',
        timestamp: 1001,
      },
    ];

    const zipPath = path.join(tempDir, 'handoff.yorkchat');
    const exportResult = await exportSessionToPath(
      {
        getSession: () => session,
        getMessages: () => messages,
        getTraceSteps: () => traceSteps,
        appVersion: '2.8.0',
      },
      session.id,
      zipPath
    );
    expect(exportResult.success).toBe(true);
    expect(fs.existsSync(zipPath)).toBe(true);

    const importCwd = path.join(tempDir, 'importer-cwd');
    fs.mkdirSync(importCwd, { recursive: true });

    const createdSessions: Session[] = [];
    const createdMessages: Message[] = [];
    const createdTraces: TraceStep[] = [];

    const db = makeDb({
      sessions: {
        create: vi.fn((row) => {
          createdSessions.push({
            id: row.id,
            title: row.title,
            status: row.status as Session['status'],
            cwd: row.cwd || undefined,
            mountedPaths: JSON.parse(row.mounted_paths),
            allowedTools: JSON.parse(row.allowed_tools),
            memoryEnabled: row.memory_enabled === 1,
            model: row.model || undefined,
            division: (row.division as Session['division']) || 'general',
            hubProjectId: row.hub_project_id,
            hubProjectName: row.hub_project_name,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
        }),
        get: vi.fn(() => null),
        getAll: vi.fn(() => []),
        update: vi.fn(),
        delete: vi.fn(),
      },
      messages: {
        create: vi.fn((row) => {
          createdMessages.push({
            id: row.id,
            sessionId: row.session_id,
            role: row.role as Message['role'],
            content: JSON.parse(row.content),
            timestamp: row.timestamp,
          });
        }),
        getBySessionId: vi.fn(() => []),
        delete: vi.fn(),
        deleteBySessionId: vi.fn(),
        update: vi.fn(),
      },
      traceSteps: {
        create: vi.fn((row) => {
          createdTraces.push({
            id: row.id,
            type: row.type as TraceStep['type'],
            status: row.status as TraceStep['status'],
            title: row.title,
            timestamp: row.timestamp,
          });
        }),
        update: vi.fn(),
        getBySessionId: vi.fn(() => []),
        deleteBySessionId: vi.fn(),
      },
    });

    const manager = new SessionManager(db, vi.fn());
    const importResult = await importSessionFromPath(
      {
        importSession: (payload, attachmentFiles, options) =>
          manager.importSessionFromPayload(payload, attachmentFiles, options),
      },
      zipPath,
      { cwd: importCwd }
    );

    expect(importResult.success).toBe(true);
    expect(importResult.session).toBeTruthy();
    expect(importResult.session!.id).not.toBe('export-session');
    expect(importResult.session!.title).toBe('Handoff Chat');
    expect(importResult.session!.claudeSessionId).toBeUndefined();
    expect(importResult.session!.openaiThreadId).toBeUndefined();
    expect(importResult.session!.cwd).toBe(importCwd);

    expect(createdMessages).toHaveLength(2);
    expect(createdMessages[0].id).not.toBe('old-msg-1');
    expect(createdMessages[0].sessionId).toBe(importResult.session!.id);
    expect(createdMessages[0].content.some((b) => b.type === 'file_attachment')).toBe(true);

    const fileBlock = createdMessages[0].content.find((b) => b.type === 'file_attachment') as {
      relativePath: string;
      filename: string;
    };
    const stagedPath = path.join(importCwd, fileBlock.relativePath);
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(fs.readFileSync(stagedPath, 'utf8')).toBe('attachment-body');

    expect(createdTraces).toHaveLength(1);
    expect(createdTraces[0].id).not.toBe('old-trace');

    // Imported history is available for continue / cold-start preamble
    const loaded = manager.getMessages(importResult.session!.id);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('rejects invalid archives', async () => {
    const badPath = path.join(tempDir, 'bad.yorkchat');
    fs.writeFileSync(badPath, 'not-a-zip');
    const result = await importSessionFromPath(
      {
        importSession: () => {
          throw new Error('should not be called');
        },
      },
      badPath
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
