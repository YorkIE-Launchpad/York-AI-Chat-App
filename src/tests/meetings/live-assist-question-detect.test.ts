import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWERS_PER_MEETING,
  MIN_QUESTION_HEURISTIC_CHARS,
  QUESTION_DEDUP_MS,
  findQuestionCandidateInWindow,
  hashQuestionForDedup,
  matchesQuestionHeuristic,
  stripSpeakerPrefix,
} from '../../main/meetings/live-assist-question-detect';
import {
  buildLiveAssistAnswerPlanPrompt,
  buildLiveAssistSummarizePrompt,
} from '../../main/meetings/live-assist-answer';
import { truncateTranscriptWindow } from '../../main/meetings/live-assist-service';

describe('live-assist-question-detect', () => {
  it('matches common question patterns', () => {
    expect(matchesQuestionHeuristic('What is the timeline for launch?')).toBe(true);
    expect(matchesQuestionHeuristic('Sam: What is the timeline for launch?')).toBe(true);
    expect(matchesQuestionHeuristic('Tell me about the launch timeline')).toBe(true);
    expect(matchesQuestionHeuristic('ok')).toBe(false);
    expect('x'.repeat(MIN_QUESTION_HEURISTIC_CHARS).length).toBeGreaterThanOrEqual(
      MIN_QUESTION_HEURISTIC_CHARS
    );
  });

  it('strips speaker prefix before matching', () => {
    const stripped = stripSpeakerPrefix('Alex: What is our Q3 revenue?');
    expect(stripped.speaker).toBe('Alex');
    expect(stripped.text).toBe('What is our Q3 revenue?');
    expect(matchesQuestionHeuristic('Alex: What is our Q3 revenue?')).toBe(true);
  });

  it('finds the latest question line in a transcript window', () => {
    const window = ['Alex: status update', 'Sam: What is our Q3 revenue?'].join('\n');
    expect(findQuestionCandidateInWindow(window)).toBe('Sam: What is our Q3 revenue?');
  });

  it('hashes questions for dedup', () => {
    const a = hashQuestionForDedup('What is Q3 revenue?');
    const b = hashQuestionForDedup('Sam: What is Q3 revenue?');
    expect(a).toBe(b);
  });

  it('exports cost guard constants', () => {
    expect(MAX_ANSWERS_PER_MEETING).toBe(8);
    expect(QUESTION_DEDUP_MS).toBeGreaterThan(0);
    expect(truncateTranscriptWindow('abc', 2)).toBe('bc');
  });
});

describe('live-assist answer prompts', () => {
  const baseOptions = {
    question: 'What is our Q3 revenue?',
    transcriptWindow: 'Sam: What is our Q3 revenue?',
    meetingTitle: 'Finance sync',
    prepContext: 'Bring Q3 numbers',
    customInstructions: 'Focus on Hub data',
    mcpManager: { getTools: () => [] } as never,
  };

  it('builds plan prompt with question and catalog', () => {
    const prompt = buildLiveAssistAnswerPlanPrompt(baseOptions, '- mcp__Hub__list_projects (Hub): List projects');
    expect(prompt).toContain('What is our Q3 revenue?');
    expect(prompt).toContain('Finance sync');
    expect(prompt).toContain('Bring Q3 numbers');
    expect(prompt).toContain('mcp__Hub__list_projects');
  });

  it('builds summarize prompt with tool results', () => {
    const prompt = buildLiveAssistSummarizePrompt(baseOptions, [
      { tool: 'mcp__Hub__list_projects', text: 'Project A: $1.2M' },
    ]);
    expect(prompt).toContain('What is our Q3 revenue?');
    expect(prompt).toContain('mcp__Hub__list_projects');
    expect(prompt).toContain('Project A: $1.2M');
  });
});
