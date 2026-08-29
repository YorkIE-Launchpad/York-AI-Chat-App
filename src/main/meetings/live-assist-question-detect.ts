import { configStore } from '../config/config-store';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { logWarn } from '../utils/logger';
import { truncateTranscriptWindow } from './live-assist-service';

export const QUESTION_DEBOUNCE_MS = 4_000;
export const QUESTION_COOLDOWN_MS = 45_000;
export const MAX_SUBAGENT_ANSWERS_PER_MEETING = 8;
export const MIN_QUESTION_HEURISTIC_CHARS = 12;

const QUESTION_PATTERNS = [
  /\?/,
  /\bwhat\s+(is|are|was|were|do|does|did|would|should)\b/i,
  /\bhow\s+(do|does|did|can|could|should|would|much|many|long)\b/i,
  /\bcan\s+(you|we|anyone|somebody)\b/i,
  /\bcould\s+(you|we|anyone)\b/i,
  /\banyone\s+know\b/i,
  /\bdoes\s+anyone\b/i,
  /\bdo\s+we\s+have\b/i,
  /\bwhen\s+(is|are|was|were|do|does|did)\b/i,
  /\bwhere\s+(is|are|was|were|do|does|did)\b/i,
  /\bwho\s+(is|are|was|were|owns|leads)\b/i,
  /\bwhy\s+(is|are|was|were|do|does|did)\b/i,
];

export function matchesQuestionHeuristic(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_QUESTION_HEURISTIC_CHARS) {
    return false;
  }
  return QUESTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function findQuestionCandidateInWindow(transcriptWindow: string): string | null {
  const lines = transcriptWindow
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (matchesQuestionHeuristic(line)) {
      return line;
    }
  }
  return null;
}

export interface LiveQuestionClassification {
  answerable: boolean;
  question: string;
}

export async function classifyLiveQuestion(
  transcriptWindow: string,
  candidateLine: string
): Promise<LiveQuestionClassification | null> {
  const prompt = [
    'You classify whether a live meeting utterance is an answerable question for an assistant.',
    'Return JSON only: {"answerable":boolean,"question":string}',
    'answerable=true for direct factual or company/work questions someone might want help answering live.',
    'answerable=false for rhetorical questions, small talk, or unclear fragments.',
    '',
    'Recent transcript:',
    transcriptWindow || '(empty)',
    '',
    'Candidate line:',
    candidateLine,
  ].join('\n');

  try {
    const result = await runPiAiOneShot(
      prompt,
      'Return JSON only.',
      configStore.getAll(),
      { maxTokens: 128, temperature: 0 }
    );
    const parsed = JSON.parse(result.text.trim()) as {
      answerable?: boolean;
      question?: string;
    };
    if (!parsed.answerable || !parsed.question?.trim()) {
      return { answerable: false, question: candidateLine };
    }
    return {
      answerable: true,
      question: parsed.question.trim(),
    };
  } catch (error) {
    logWarn('[LiveAssist] Question classifier failed:', error);
    if (matchesQuestionHeuristic(candidateLine) && candidateLine.includes('?')) {
      return { answerable: true, question: candidateLine };
    }
    return null;
  }
}

export function buildLiveAssistSubagentTask(options: {
  question: string;
  transcriptWindow: string;
  prepContext?: string | null;
  customInstructions?: string;
  meetingTitle: string;
}): string {
  const sections = [
    'You are a background research subagent for York IE Live Assist during a live meeting.',
    'Answer the detected meeting question concisely and accurately.',
    'Use MCP tools (Hub, Slack, Gmail, Calendar, past meetings) when internal company context is needed.',
    'Use webSearch only when internal sources are insufficient.',
    'Do not invent facts. If uncertain, say what is known and what is missing.',
    'Keep the final answer under 8 sentences.',
    '',
    `Meeting: ${options.meetingTitle}`,
    `Question: ${options.question}`,
  ];

  if (options.prepContext?.trim()) {
    sections.push('', 'Meeting prep:', options.prepContext.trim());
  }

  if (options.customInstructions?.trim()) {
    sections.push('', 'User instructions:', options.customInstructions.trim());
  }

  sections.push(
    '',
    'Recent transcript window:',
    truncateTranscriptWindow(options.transcriptWindow)
  );

  return sections.join('\n');
}
