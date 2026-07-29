import { describe, expect, it } from 'vitest';
import type { Message } from '../../renderer/types';
import {
  findLatestUserMessageId,
  hasAssistantTextResponseForTurn,
  hasStreamingText,
  messageHasAssistantText,
} from '../../renderer/utils/active-turn';

function msg(id: string, role: Message['role'], text: string, sessionId = 's1'): Message {
  return {
    id,
    sessionId,
    role,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

describe('active-turn helpers', () => {
  it('detects assistant text responses after the anchored user message', () => {
    const messages = [msg('u1', 'user', 'hello'), msg('a1', 'assistant', 'hi there')];
    expect(hasAssistantTextResponseForTurn(messages, 'u1')).toBe(true);
    expect(hasAssistantTextResponseForTurn(messages, 'missing')).toBe(false);
  });

  it('ignores tool_result-only assistant rows when checking for a text reply', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'run tool'),
      {
        id: 'tr1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
        timestamp: Date.now(),
      },
    ];
    expect(hasAssistantTextResponseForTurn(messages, 'u1')).toBe(false);
    expect(messageHasAssistantText(messages[1])).toBe(false);
  });

  it('finds the latest user message id', () => {
    const messages = [msg('u1', 'user', 'first'), msg('u2', 'user', 'second')];
    expect(findLatestUserMessageId(messages)).toBe('u2');
  });

  it('tracks streaming text presence', () => {
    expect(hasStreamingText('', '')).toBe(false);
    expect(hasStreamingText('hello', '')).toBe(true);
    expect(hasStreamingText('', 'thinking')).toBe(true);
  });
});

describe('beginActiveTurn store action', () => {
  it('binds a turn directly when thinking arrives before optimistic activation', async () => {
    const { useAppStore } = await import('../../renderer/store');
    useAppStore.setState({ sessions: [], activeSessionId: null, sessionStates: {} });

    const sessionId = 'session-race';
    useAppStore.getState().addMessage(sessionId, msg('u1', 'user', 'hello', sessionId));
    useAppStore.getState().beginActiveTurn(sessionId, 'real-step', 'u1');

    expect(useAppStore.getState().sessionStates[sessionId]?.activeTurn).toEqual({
      stepId: 'real-step',
      userMessageId: 'u1',
    });
    expect(useAppStore.getState().sessionStates[sessionId]?.pendingTurns).toEqual([]);
  });
});
