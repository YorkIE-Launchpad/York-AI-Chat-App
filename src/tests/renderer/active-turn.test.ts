import { describe, expect, it } from 'vitest';
import type { Message } from '../../renderer/types';
import {
  findLatestUserMessageId,
  hasAssistantTextResponseForTurn,
  hasStreamingText,
  isCompactionTraceStep,
  isPendingStepId,
  messageHasAssistantText,
  messageHasToolUse,
  shouldClearActiveTurnOnStreamMessage,
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

  it('detects tool_use blocks and only clears activeTurn for text-only replies', () => {
    const textOnly = msg('a1', 'assistant', 'done');
    const textAndTools: Message = {
      id: 'a2',
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
      timestamp: Date.now(),
    };
    const toolsOnly: Message = {
      id: 'a3',
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      timestamp: Date.now(),
    };

    expect(messageHasToolUse(textOnly)).toBe(false);
    expect(messageHasToolUse(textAndTools)).toBe(true);
    expect(shouldClearActiveTurnOnStreamMessage(textOnly)).toBe(true);
    expect(shouldClearActiveTurnOnStreamMessage(textAndTools)).toBe(false);
    expect(shouldClearActiveTurnOnStreamMessage(toolsOnly)).toBe(false);
  });

  it('identifies compaction trace steps without binding activeTurn', () => {
    expect(
      isCompactionTraceStep({
        id: 'compaction-123',
        title: 'Compacting context (overflow)...',
      })
    ).toBe(true);
    expect(
      isCompactionTraceStep({
        id: 'compaction-end-456',
        title: 'Context compaction completed',
      })
    ).toBe(true);
    expect(
      isCompactionTraceStep({
        id: 'thinking-abc',
        title: 'Compacting context (tokens)...',
      })
    ).toBe(true);
    expect(isCompactionTraceStep({ id: 'thinking-abc', title: 'Working...' })).toBe(false);
  });

  it('detects optimistic pending-step ids', () => {
    expect(isPendingStepId('pending-step-123')).toBe(true);
    expect(isPendingStepId('real-step')).toBe(false);
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
