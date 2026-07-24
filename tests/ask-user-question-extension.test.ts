import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AskUserQuestionExtension,
  ASK_USER_QUESTION_MAX_PER_RUN,
  sanitizeAskUserQuestions,
  normalizeAskUserAnswers,
  getInvalidAskUserQuestionRootKeys,
} from '../src/main/tools/ask-user-question-extension';
import type { ServerEvent, Session } from '../src/renderer/types';

function makeSession(id = 'sess-1'): Session {
  return {
    id,
    title: 'Test',
    status: 'running',
    cwd: '/tmp',
    mountedPaths: [],
    allowedTools: [],
    memoryEnabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('AskUserQuestion sanitize/normalize', () => {
  it('rejects invalid root keys', () => {
    expect(getInvalidAskUserQuestionRootKeys({ header: 'x', questions: [] })).toEqual(['header']);
    expect(getInvalidAskUserQuestionRootKeys({ questions: [] })).toEqual([]);
  });

  it('sanitizes questions and ensures one recommended option', () => {
    const questions = sanitizeAskUserQuestions({
      questions: [
        {
          question: 'Pick a mode',
          options: [
            { label: 'Fast' },
            { label: 'Safe', recommended: true },
            { label: 'Extra', recommended: true },
          ],
        },
      ],
    });
    expect(questions).toHaveLength(1);
    expect(questions[0].options?.map((o) => o.recommended)).toEqual([undefined, true, undefined]);
  });

  it('defaults first option to recommended when none marked', () => {
    const questions = sanitizeAskUserQuestions({
      questions: [
        {
          question: 'Pick',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    });
    expect(questions[0].options?.[0].recommended).toBe(true);
  });

  it('normalizes multiSelect answers to string arrays', () => {
    const questions = sanitizeAskUserQuestions({
      questions: [
        {
          question: 'Pick many',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        },
      ],
    });
    const normalized = normalizeAskUserAnswers(JSON.stringify({ 0: ['A', 'C'] }), questions);
    expect(normalized).toEqual({ '0': ['A', 'C'] });
  });
});

describe('AskUserQuestionExtension', () => {
  let events: ServerEvent[];
  let extension: AskUserQuestionExtension;

  beforeEach(() => {
    events = [];
    extension = new AskUserQuestionExtension((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers AskUserQuestion custom tool and resets ask budget per run', async () => {
    const result = await extension.beforeSessionRun({
      session: makeSession(),
      prompt: 'hi',
      existingMessages: [],
      isColdStart: true,
    });
    expect(result.customTools?.[0]?.name).toBe('AskUserQuestion');
  });

  it('rejects a 3rd ask in the same run without opening UI', async () => {
    const session = makeSession();
    await extension.beforeSessionRun({
      session,
      prompt: 'hi',
      existingMessages: [],
      isColdStart: true,
    });

    const ask = (id: string) =>
      extension.executeAsk(session.id, id, {
        questions: [
          {
            question: 'Q?',
            options: [{ label: 'A', recommended: true }, { label: 'B' }],
          },
        ],
      });

    const p1 = ask('tool-1');
    expect(events.some((e) => e.type === 'question.request')).toBe(true);
    const q1 = events.find((e) => e.type === 'question.request')!;
    expect(q1.type).toBe('question.request');
    extension.handleQuestionResponse(q1.payload.questionId, JSON.stringify({ 0: ['A'] }));
    await p1;

    events.length = 0;
    const p2 = ask('tool-2');
    const q2 = events.find((e) => e.type === 'question.request')!;
    extension.handleQuestionResponse(q2.payload.questionId, JSON.stringify({ 0: ['B'] }));
    await p2;

    events.length = 0;
    const third = await ask('tool-3');
    expect(events.filter((e) => e.type === 'question.request')).toHaveLength(0);
    expect(third.content[0].text).toContain('Ask budget exhausted');
    expect(ASK_USER_QUESTION_MAX_PER_RUN).toBe(2);
  });

  it('cancelQuestion dismisses and returns cancelled error (not empty success)', async () => {
    const session = makeSession();
    await extension.beforeSessionRun({
      session,
      prompt: 'hi',
      existingMessages: [],
      isColdStart: true,
    });

    const pending = extension.executeAsk(session.id, 'tool-x', {
      questions: [{ question: 'Need detail?', options: [{ label: 'Yes', recommended: true }] }],
    });

    const req = events.find((e) => e.type === 'question.request');
    expect(req?.type).toBe('question.request');
    if (!req || req.type !== 'question.request') {
      throw new Error('expected question.request');
    }

    extension.cancelQuestion(req.payload.questionId, 'test cancel');
    const result = await pending;
    expect(result.content[0].text).toContain('cancelled');
    expect(events.some((e) => e.type === 'question.dismiss')).toBe(true);
  });

  it('dismissSessionQuestions resolves all pending for the session', async () => {
    const session = makeSession();
    await extension.beforeSessionRun({
      session,
      prompt: 'hi',
      existingMessages: [],
      isColdStart: true,
    });

    const pending = extension.executeAsk(session.id, 'tool-y', {
      questions: [{ question: 'Q?', options: [{ label: 'A', recommended: true }] }],
    });

    extension.dismissSessionQuestions(session.id, 'session stopped');
    const result = await pending;
    expect(result.content[0].text).toContain('session stopped');
  });
});
