import { describe, expect, it } from 'vitest';
import { eventRequiresSessionManager } from '../src/main/client-event-utils';
import type { ClientEvent } from '../src/renderer/types';

function makeEvent(type: ClientEvent['type']): ClientEvent {
  switch (type) {
    case 'session.start':
      return { type, payload: { title: 'Hello', prompt: 'World' } };
    case 'session.create':
      return { type, payload: { title: 'Matter · Item' } };
    case 'session.continue':
      return { type, payload: { sessionId: 'session-1', prompt: 'Next' } };
    case 'session.stop':
    case 'session.delete':
    case 'session.getMessages':
    case 'session.getTraceSteps':
    case 'session.getContextUsage':
      return { type, payload: { sessionId: 'session-1' } };
    case 'session.dequeue':
      return { type, payload: { sessionId: 'session-1', queueIndex: 0 } };
    case 'session.batchDelete':
      return { type, payload: { sessionIds: ['session-1'] } };
    case 'session.setPinned':
      return { type, payload: { sessionId: 'session-1', pinned: true } };
    case 'session.setTitle':
      return { type, payload: { sessionId: 'session-1', title: 'Renamed' } };
    case 'session.compact':
      return { type, payload: { sessionId: 'session-1' } };
    case 'session.searchChats':
      return { type, payload: { query: 'hello' } };
    case 'session.list':
    case 'settings.update':
    case 'folder.select':
    case 'workdir.get':
      return { type, payload: {} };
    case 'permission.response':
      return { type, payload: { toolUseId: 'tool-1', result: 'allow' } };
    case 'question.response':
      return { type, payload: { questionId: 'q-1', answer: { answers: {} } } };
    case 'sudo.password.response':
      return { type, payload: { toolUseId: 'tool-1', password: null } };
    case 'workdir.set':
      return { type, payload: { path: '/tmp/demo' } };
    case 'workdir.select':
      return { type, payload: { currentPath: '/tmp/demo' } };
    default: {
      // Keep helper usable for the subset exercised by this suite; other ClientEvent
      // types are covered elsewhere and do not affect eventRequiresSessionManager.
      return { type: 'settings.update', payload: {} };
    }
  }
}

describe('eventRequiresSessionManager', () => {
  it('requires a session manager only for session and permission events', () => {
    const requiredTypes: ClientEvent['type'][] = [
      'session.start',
      'session.create',
      'session.continue',
      'session.stop',
      'session.dequeue',
      'session.delete',
      'session.batchDelete',
      'session.setPinned',
      'session.setTitle',
      'session.list',
      'session.getMessages',
      'session.getTraceSteps',
      'session.searchChats',
      'permission.response',
    ];

    for (const type of requiredTypes) {
      expect(eventRequiresSessionManager(makeEvent(type))).toBe(true);
    }
  });

  it('allows folder and workdir interactions before session manager is ready', () => {
    const optionalTypes: ClientEvent['type'][] = [
      'settings.update',
      'folder.select',
      'workdir.get',
      'workdir.set',
      'workdir.select',
    ];

    for (const type of optionalTypes) {
      expect(eventRequiresSessionManager(makeEvent(type))).toBe(false);
    }
  });
});
