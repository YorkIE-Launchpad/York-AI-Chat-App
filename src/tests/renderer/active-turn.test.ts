import { describe, expect, it } from 'vitest';
import type { Message, TraceStep } from '../../renderer/types';
import {
  findLatestUserMessageId,
  hasAssistantTextResponseForTurn,
  hasInProgressToolUseForTurn,
  hasStreamingText,
  isCompactionTraceStep,
  isPendingStepId,
  messageHasAssistantText,
  messageHasToolUse,
  resolveActiveTurnStatusLabel,
  shouldClearActiveTurnOnStreamMessage,
} from '../../renderer/utils/active-turn';

function traceStep(
  partial: Partial<TraceStep> & Pick<TraceStep, 'id' | 'type' | 'status'>
): TraceStep {
  return {
    title: '',
    timestamp: Date.now(),
    ...partial,
  };
}

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

  it('resolves wait-status label preferring running tool_call over thinking', () => {
    expect(resolveActiveTurnStatusLabel([])).toBeNull();
    expect(
      resolveActiveTurnStatusLabel([
        traceStep({ id: 't1', type: 'thinking', status: 'completed', title: 'Done' }),
      ])
    ).toBeNull();

    expect(
      resolveActiveTurnStatusLabel([
        traceStep({
          id: 'think',
          type: 'thinking',
          status: 'running',
          title: 'Processing request...',
        }),
      ])
    ).toBe('Processing request...');

    expect(
      resolveActiveTurnStatusLabel([
        traceStep({
          id: 'think',
          type: 'thinking',
          status: 'running',
          title: 'Processing request...',
        }),
        traceStep({
          id: 'tool-1',
          type: 'tool_call',
          status: 'running',
          title: 'Read',
          toolName: 'Read',
        }),
      ])
    ).toBe('Read');

    expect(
      resolveActiveTurnStatusLabel([
        traceStep({
          id: 'think',
          type: 'thinking',
          status: 'running',
          title: 'Waiting for model to load into memory...',
        }),
        traceStep({
          id: 'compaction-1',
          type: 'thinking',
          status: 'running',
          title: 'Compacting context...',
        }),
      ])
    ).toBe('Waiting for model to load into memory...');

    expect(
      resolveActiveTurnStatusLabel([
        traceStep({
          id: 'compaction-1',
          type: 'thinking',
          status: 'running',
          title: 'Compacting context...',
        }),
      ])
    ).toBe('Compacting context...');

    expect(
      resolveActiveTurnStatusLabel([
        traceStep({
          id: 'tool-1',
          type: 'tool_call',
          status: 'running',
          title: '',
          toolName: 'Bash',
        }),
      ])
    ).toBe('Bash');
  });

  it('detects in-progress tool_use for the anchored turn', () => {
    const withOpenTool: Message[] = [
      msg('u1', 'user', 'run tool'),
      {
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        timestamp: Date.now(),
      },
    ];
    expect(hasInProgressToolUseForTurn(withOpenTool, 'u1')).toBe(true);
    expect(hasInProgressToolUseForTurn(withOpenTool, 'missing')).toBe(false);

    const withResult: Message[] = [
      ...withOpenTool,
      {
        id: 'a2',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
        timestamp: Date.now(),
      },
    ];
    expect(hasInProgressToolUseForTurn(withResult, 'u1')).toBe(false);

    const stoppedByNextUser: Message[] = [
      msg('u1', 'user', 'first'),
      {
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        timestamp: Date.now(),
      },
      msg('u2', 'user', 'second'),
    ];
    expect(hasInProgressToolUseForTurn(stoppedByNextUser, 'u1')).toBe(true);
    expect(hasInProgressToolUseForTurn(stoppedByNextUser, 'u2')).toBe(false);
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
