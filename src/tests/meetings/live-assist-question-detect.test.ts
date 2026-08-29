import { describe, expect, it } from 'vitest';
import {
  MAX_SUBAGENT_ANSWERS_PER_MEETING,
  MIN_QUESTION_HEURISTIC_CHARS,
  QUESTION_COOLDOWN_MS,
  buildLiveAssistSubagentTask,
  findQuestionCandidateInWindow,
  matchesQuestionHeuristic,
} from '../../main/meetings/live-assist-question-detect';
import { truncateTranscriptWindow } from '../../main/meetings/live-assist-service';

describe('live-assist-question-detect', () => {
  it('matches common question patterns', () => {
    expect(matchesQuestionHeuristic('What is the timeline for launch?')).toBe(true);
    expect(matchesQuestionHeuristic('ok')).toBe(false);
    expect('x'.repeat(MIN_QUESTION_HEURISTIC_CHARS).length).toBeGreaterThanOrEqual(
      MIN_QUESTION_HEURISTIC_CHARS
    );
  });

  it('finds the latest question line in a transcript window', () => {
    const window = ['Alex: status update', 'Sam: What is our Q3 revenue?'].join('\n');
    expect(findQuestionCandidateInWindow(window)).toBe('Sam: What is our Q3 revenue?');
  });

  it('builds a subagent task with question and transcript context', () => {
    const task = buildLiveAssistSubagentTask({
      question: 'What is our Q3 revenue?',
      transcriptWindow: 'Sam: What is our Q3 revenue?',
      meetingTitle: 'Finance sync',
      prepContext: 'Bring Q3 numbers',
      customInstructions: 'Focus on Hub data',
    });
    expect(task).toContain('What is our Q3 revenue?');
    expect(task).toContain('Finance sync');
    expect(task).toContain('Bring Q3 numbers');
    expect(task).toContain('Focus on Hub data');
  });

  it('exports cost guard constants', () => {
    expect(MAX_SUBAGENT_ANSWERS_PER_MEETING).toBe(8);
    expect(QUESTION_COOLDOWN_MS).toBeGreaterThan(0);
    expect(truncateTranscriptWindow('abc', 2)).toBe('bc');
  });
});
