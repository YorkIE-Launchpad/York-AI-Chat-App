import { describe, expect, it } from 'vitest';
import {
  parseRemoteQuestionResponse,
  formatRemoteQuestionMessage,
} from '../src/main/remote/remote-manager';

const multiQuestions = [
  {
    question: 'Which framework?',
    options: [{ label: 'React', recommended: true }, { label: 'Vue' }, { label: 'Svelte' }],
  },
  {
    question: 'Which style?',
    multiSelect: true,
    options: [{ label: 'CSS' }, { label: 'Tailwind', recommended: true }, { label: 'Uno' }],
  },
];

describe('parseRemoteQuestionResponse', () => {
  it('parses per-question Q1/Q2 lines for multi-question forms', () => {
    const json = parseRemoteQuestionResponse('Q1: A\nQ2: B,C', multiQuestions);
    expect(JSON.parse(json)).toEqual({
      0: ['React'],
      1: ['Tailwind', 'Uno'],
    });
  });

  it('accepts bare letter/number for single-question forms', () => {
    const json = parseRemoteQuestionResponse('B', [multiQuestions[0]]);
    expect(JSON.parse(json)).toEqual({ 0: ['Vue'] });
  });

  it('does not apply one digit list to every question in multi-question forms', () => {
    const json = parseRemoteQuestionResponse('1,2', multiQuestions);
    expect(JSON.parse(json)).toEqual({});
  });

  it('handles skip', () => {
    expect(parseRemoteQuestionResponse('skip', multiQuestions)).toBe('{}');
  });
});

describe('formatRemoteQuestionMessage', () => {
  it('includes Q labels and Recommended markers', () => {
    const text = formatRemoteQuestionMessage(multiQuestions);
    expect(text).toContain('**Q1**');
    expect(text).toContain('**Q2**');
    expect(text).toContain('*(Recommended)*');
    expect(text).toContain('Q1: A');
  });
});
