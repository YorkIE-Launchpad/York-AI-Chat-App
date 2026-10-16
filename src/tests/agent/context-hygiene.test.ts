import { describe, expect, it, vi } from 'vitest';

const compactMock = vi.hoisted(() => vi.fn());
vi.mock('@mariozechner/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  compact: compactMock,
}));

import Database from 'better-sqlite3';
import {
  applyContextHygiene,
  compactionSettingsForWindow,
  effectiveContextWindow,
  stripEphemeralBlocks,
  stripStaleTurnContext,
  summaryReserveTokens,
  trimOldToolResults,
} from '../../main/agent/context-hygiene';
import { buildColdStartRecap } from '../../main/agent/cold-start-recap';
import { createCompactionExtensionFactory } from '../../main/agent/compaction-extension';
import { ContextSummaryStore } from '../../main/agent/context-summary-store';
import type { Message } from '../../renderer/types';

const turnPrefix = (n: number) =>
  `<turn_context>\nToday ${n}\n</turn_context>\n\n<per_turn_context>\n<memory_context>\nmem ${n}\n</memory_context>\n</per_turn_context>\n\n`;

function user(text: string) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
}

function toolResult(text: string) {
  return { role: 'toolResult', toolCallId: 't', toolName: 'x', content: [{ type: 'text', text }] };
}

function assistant(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('stripEphemeralBlocks', () => {
  it('removes per-turn blocks and keeps the user text and history', () => {
    const text = `${turnPrefix(1)}<conversation_history>\nold\n</conversation_history>\n\nWhat is the revenue?\n\n<active_project_context>\nAcme\n</active_project_context>`;
    const stripped = stripEphemeralBlocks(text);
    expect(stripped).toContain('What is the revenue?');
    expect(stripped).toContain('<conversation_history>');
    expect(stripped).not.toContain('turn_context');
    expect(stripped).not.toContain('memory_context');
    expect(stripped).not.toContain('active_project_context');
  });

  it('leaves plain text untouched', () => {
    expect(stripEphemeralBlocks('hello')).toBe('hello');
  });
});

describe('stripStaleTurnContext', () => {
  it('keeps prefixes on the two most recent user turns only, without mutating input', () => {
    const messages = [1, 2, 3, 4].flatMap((n) => [
      user(`${turnPrefix(n)}question ${n}`),
      assistant(`answer ${n}`),
    ]);
    const original = JSON.stringify(messages);
    const { messages: next, strippedCount } = stripStaleTurnContext(messages);
    expect(strippedCount).toBe(2);
    expect(next[0].content[0].text).toBe('question 1');
    expect(next[2].content[0].text).toBe('question 2');
    expect(next[4].content[0].text).toContain('mem 3');
    expect(next[6].content[0].text).toContain('mem 4');
    expect(JSON.stringify(messages)).toBe(original);
  });
});

describe('trimOldToolResults', () => {
  it('does nothing under budget', () => {
    const messages = [user('q'), toolResult('x'.repeat(10_000))];
    expect(trimOldToolResults(messages, { budgetChars: 1_000_000 }).trimmedCount).toBe(0);
  });

  it('trims old large outputs to an excerpt and protects recent turns', () => {
    const messages = [
      user('q1'),
      toolResult(`HEAD-1 ${'a'.repeat(20_000)}`),
      assistant('a1'),
      user('q2'),
      toolResult('b'.repeat(20_000)),
      assistant('a2'),
      user('q3'),
      toolResult('c'.repeat(20_000)),
    ];
    const { messages: next, trimmedCount } = trimOldToolResults(messages, {
      budgetChars: 30_000,
    });
    expect(trimmedCount).toBe(1);
    expect(next[1].content[0].text.startsWith('HEAD-1')).toBe(true);
    expect(next[1].content[0].text).toContain('earlier tool output trimmed');
    expect(next[1].content[0].text.length).toBeLessThan(2500);
    expect(next[4].content[0].text).toHaveLength(20_000);
    expect(next[7].content[0].text).toHaveLength(20_000);
    expect(messages[1].content[0].text.length).toBeGreaterThan(20_000);
  });

  it('applyContextHygiene trims only past half the effective window', () => {
    const small = [user('q1'), toolResult('x'.repeat(50_000)), user('q2'), user('q3')];
    expect(applyContextHygiene(small, 200_000).trimmedCount).toBe(0);
    const big = [user('q1'), toolResult('x'.repeat(500_000)), user('q2'), user('q3')];
    expect(applyContextHygiene(big, 200_000).trimmedCount).toBe(1);
  });
});

describe('compaction tuning', () => {
  it('caps the effective window and scales reserve/keep', () => {
    expect(effectiveContextWindow(1_000_000)).toBe(200_000);
    expect(effectiveContextWindow(undefined)).toBe(128_000);
    const huge = compactionSettingsForWindow(1_000_000);
    expect(1_000_000 - huge.reserveTokens).toBe(200_000 - 16_384);
    expect(huge.keepRecentTokens).toBe(40_000);
    const normal = compactionSettingsForWindow(128_000);
    expect(normal.reserveTokens).toBe(16_384);
    expect(normal.keepRecentTokens).toBe(25_600);
    expect(summaryReserveTokens(8192)).toBe(10_240);
    expect(summaryReserveTokens(64_000)).toBe(16_384);
  });
});

describe('buildColdStartRecap', () => {
  const msg = (role: 'user' | 'assistant', text: string): Message => ({
    id: Math.random().toString(),
    sessionId: 's',
    role,
    content: [{ type: 'text', text }],
    timestamp: 1,
  });

  it('returns nothing when no messages were omitted', () => {
    expect(buildColdStartRecap({ omitted: [], summary: 'x', charBudget: 1000 })).toBe('');
  });

  it('includes summary and digest of omitted requests', () => {
    const recap = buildColdStartRecap({
      omitted: [
        msg('user', 'What was Q3 revenue for Acme?'),
        msg('assistant', 'Q3 revenue was $4.2M.'),
      ],
      summary: '## Goal\nAcme financial review',
      charBudget: 4000,
    });
    expect(recap).toContain('omitted_messages="2"');
    expect(recap).toContain('Acme financial review');
    expect(recap).toContain('User asked: What was Q3 revenue for Acme?');
    expect(recap).toContain('Answer began: Q3 revenue was $4.2M.');
  });

  it('keeps the newest requests when over budget', () => {
    const omitted = Array.from({ length: 50 }, (_, i) => msg('user', `question number ${i}`));
    const recap = buildColdStartRecap({ omitted, charBudget: 300 });
    expect(recap).toContain('question number 49');
    expect(recap).not.toContain('question number 0\n');
  });
});

describe('compaction extension summary path', () => {
  function captureHandler(onCompacted?: (s: string) => void) {
    let handler: ((event: unknown, ctx?: unknown) => Promise<unknown>) | undefined;
    createCompactionExtensionFactory({ onCompacted })({
      on: (event: string, h: unknown) => {
        if (event === 'session_before_compact') handler = h as typeof handler;
      },
    } as never);
    return handler!;
  }

  function event() {
    return {
      type: 'session_before_compact',
      preparation: {
        firstKeptEntryId: 'e1',
        messagesToSummarize: [user(`${turnPrefix(1)}question`), toolResult('z'.repeat(10_000))],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 900_000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 816_384, keepRecentTokens: 40_000 },
      },
      branchEntries: [],
      customInstructions: undefined as string | undefined,
      signal: new AbortController().signal,
    };
  }

  it('summarizes with custom instructions, sane output budget, and cleaned input', async () => {
    compactMock.mockResolvedValueOnce({
      summary: 'SUMMARY',
      firstKeptEntryId: 'e1',
      tokensBefore: 1,
    });
    const saved = vi.fn();
    const evt = event();
    const result = await captureHandler(saved)(evt, {
      model: { id: 'm', maxTokens: 64_000 },
      modelRegistry: { getApiKey: async () => 'key' },
    });
    expect(result).toEqual({
      compaction: { summary: 'SUMMARY', firstKeptEntryId: 'e1', tokensBefore: 1 },
    });
    const [prep, , apiKey, instructions] = compactMock.mock.calls[0];
    expect(apiKey).toBe('key');
    expect(instructions).toContain('Focus on preserving:');
    expect(prep.settings.reserveTokens).toBe(16_384);
    expect(prep.messagesToSummarize[0].content[0].text).toBe('question');
    expect(prep.messagesToSummarize[1].content[0].text.length).toBeLessThan(3500);
    expect(saved).toHaveBeenCalledWith('SUMMARY');
  });

  it('falls back to the SDK default path when summarizing fails', async () => {
    compactMock.mockRejectedValueOnce(new Error('boom'));
    const evt = event();
    const result = await captureHandler()(evt, {
      model: { id: 'm', maxTokens: 64_000 },
      modelRegistry: { getApiKey: async () => 'key' },
    });
    expect(result).toEqual({});
    expect(evt.preparation.settings.reserveTokens).toBe(16_384);
  });
});

describe('ContextSummaryStore', () => {
  it('saves, overwrites, and cascades with the session', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run('s1');
    const store = new ContextSummaryStore(db);
    store.save('s1', 'first');
    store.save('s1', 'second');
    expect(store.get('s1')?.summary).toBe('second');
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');
    expect(store.get('s1')).toBeNull();
    db.close();
  });
});
