import { describe, expect, it } from 'vitest';
import { snapChatReducer, type SnapChatState } from '../../renderer/hooks/useSnapChat';
import type { ScreenSnapSessionEvent } from '../../shared/screen-snap';
import type { Message } from '../../renderer/types';

const empty: SnapChatState = {
  messages: [],
  partial: '',
  status: null,
  error: null,
  activeTool: null,
  permission: null,
  question: null,
};

const apply = (state: SnapChatState, ...events: ScreenSnapSessionEvent[]) =>
  events.reduce((acc, event) => snapChatReducer(acc, { type: 'event', event }), state);

const message = (id: string, role: Message['role'], text: string): Message => ({
  id,
  sessionId: 's',
  role,
  content: [{ type: 'text', text }],
  timestamp: 1,
});

describe('snapChatReducer', () => {
  it('streams partial text and replaces it with the final assistant message', () => {
    const state = apply(
      snapChatReducer(empty, { type: 'starting' }),
      { type: 'stream.message', payload: { sessionId: 's', message: message('u1', 'user', 'hi') } },
      { type: 'session.status', payload: { sessionId: 's', status: 'running' } },
      { type: 'stream.partial', payload: { sessionId: 's', delta: 'Hel' } },
      { type: 'stream.partial', payload: { sessionId: 's', delta: 'lo' } }
    );
    expect(state.partial).toBe('Hello');

    const done = apply(
      state,
      {
        type: 'stream.message',
        payload: { sessionId: 's', message: message('a1', 'assistant', 'Hello') },
      },
      { type: 'session.status', payload: { sessionId: 's', status: 'idle' } }
    );
    expect(done.partial).toBe('');
    expect(done.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(done.status).toBe('idle');
  });

  it('dedupes messages by id', () => {
    const state = apply(
      empty,
      { type: 'stream.message', payload: { sessionId: 's', message: message('u1', 'user', 'hi') } },
      { type: 'stream.message', payload: { sessionId: 's', message: message('u1', 'user', 'hi') } }
    );
    expect(state.messages).toHaveLength(1);
  });

  it('tracks the running tool and clears it when the step completes', () => {
    const running = apply(empty, {
      type: 'trace.step',
      payload: {
        sessionId: 's',
        step: {
          id: 't1',
          type: 'tool_call',
          status: 'running',
          title: 'Search',
          toolName: 'websearch',
          timestamp: 1,
        },
      },
    });
    expect(running.activeTool).toEqual({ stepId: 't1', name: 'websearch' });

    const finished = apply(running, {
      type: 'trace.update',
      payload: { sessionId: 's', stepId: 't1', updates: { status: 'completed' } },
    });
    expect(finished.activeTool).toBeNull();
  });

  it('shows and dismisses permission requests', () => {
    const asked = apply(empty, {
      type: 'permission.request',
      payload: { sessionId: 's', toolUseId: 'p1', toolName: 'bash', input: {} },
    });
    expect(asked.permission?.toolUseId).toBe('p1');
    const dismissed = apply(asked, {
      type: 'permission.dismiss',
      payload: { sessionId: 's', toolUseId: 'p1' },
    });
    expect(dismissed.permission).toBeNull();
  });
});
