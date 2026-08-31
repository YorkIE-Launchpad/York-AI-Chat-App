import { describe, expect, it } from 'vitest';
import {
  buildAskUserQuestionAnswers,
  isCustomInputOption,
  isQuestionAnswered,
} from '../src/renderer/components/message/ask-user-question-utils';
import type { QuestionItem } from '../src/renderer/types';

describe('isCustomInputOption', () => {
  it('matches enter/type/specify/custom/other/provide labels', () => {
    expect(isCustomInputOption('Enter topic')).toBe(true);
    expect(isCustomInputOption('Enter keyword')).toBe(true);
    expect(isCustomInputOption('Type your answer')).toBe(true);
    expect(isCustomInputOption('Specify details')).toBe(true);
    expect(isCustomInputOption('Custom')).toBe(true);
    expect(isCustomInputOption('Other')).toBe(true);
    expect(isCustomInputOption('Provide audience & tone')).toBe(true);
  });

  it('does not match skip or plain choice labels', () => {
    expect(isCustomInputOption('Skip')).toBe(false);
    expect(isCustomInputOption('Fast')).toBe(false);
    expect(isCustomInputOption('')).toBe(false);
  });
});

describe('isQuestionAnswered', () => {
  const blogTopicQuestion: QuestionItem = {
    header: 'BLOG TOPIC',
    question: 'What is the main topic of the blog post?',
    options: [
      { label: 'Enter topic', recommended: true },
      { label: 'Skip' },
    ],
  };

  it('requires custom text when Enter topic is selected', () => {
    const selections = { 0: ['Enter topic'] };
    expect(isQuestionAnswered(blogTopicQuestion, 0, selections, {}, {})).toBe(false);
    expect(isQuestionAnswered(blogTopicQuestion, 0, selections, {}, { 0: 'AI trends' })).toBe(
      true
    );
  });

  it('accepts Skip without custom text', () => {
    const selections = { 0: ['Skip'] };
    expect(isQuestionAnswered(blogTopicQuestion, 0, selections, {}, {})).toBe(true);
  });

  it('requires free text when question has no options', () => {
    const q: QuestionItem = { question: 'Your topic?' };
    expect(isQuestionAnswered(q, 0, {}, {}, {})).toBe(false);
    expect(isQuestionAnswered(q, 0, {}, { 0: 'SaaS growth' }, {})).toBe(true);
  });
});

describe('buildAskUserQuestionAnswers', () => {
  const questions: QuestionItem[] = [
    {
      header: 'BLOG TOPIC',
      question: 'What is the main topic?',
      options: [{ label: 'Enter topic', recommended: true }, { label: 'Skip' }],
    },
    {
      header: 'KEYWORD',
      question: 'Primary keyword?',
      options: [{ label: 'Enter keyword', recommended: true }, { label: 'Skip' }],
    },
  ];

  it('submits typed text instead of Enter topic/keyword labels', () => {
    const answers = buildAskUserQuestionAnswers(
      questions,
      { 0: ['Enter topic'], 1: ['Enter keyword'] },
      {},
      { 0: 'WordPress automation', 1: 'wordpress blog' }
    );
    expect(answers).toEqual({
      0: ['WordPress automation'],
      1: ['wordpress blog'],
    });
  });

  it('submits skip labels unchanged', () => {
    const answers = buildAskUserQuestionAnswers(
      questions,
      { 0: ['Skip'], 1: ['Skip'] },
      {},
      {}
    );
    expect(answers).toEqual({
      0: ['Skip'],
      1: ['Skip'],
    });
  });
});
