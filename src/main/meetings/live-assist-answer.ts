import { configStore } from '../config/config-store';
import { runPiAiOneShot, runPiAiStream } from '../agent/sdk-one-shot';
import { logWarn } from '../utils/logger';
import { truncateTranscriptWindow } from './live-assist-service';

export type LiveAssistProgressPhase = 'answering';

export interface LiveAssistAnswerOptions {
  question: string;
  transcriptWindow: string;
  meetingTitle: string;
  prepContext?: string | null;
  customInstructions?: string;
  onProgress?: (phase: LiveAssistProgressPhase, detail?: string) => void;
  onDelta?: (text: string) => void;
}

export function buildLiveAssistAnswerPrompt(options: LiveAssistAnswerOptions): string {
  const sections = [
    'Answer a live meeting question using only the transcript and meeting prep below.',
    'Be concise (at most 6 sentences). Do not invent facts.',
    'If data is insufficient, say what is known and what is missing.',
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

  sections.push('', 'Recent transcript:', truncateTranscriptWindow(options.transcriptWindow));

  return sections.join('\n');
}

export function buildLiveAssistFarewellPrompt(options: {
  meetingTitle: string;
  transcriptWindow: string;
  prepContext?: string | null;
}): string {
  const sections = [
    'The live meeting capture has ended.',
    'Summarize open questions, commitments, and suggested follow-ups from the transcript below.',
    'Keep it concise and actionable (at most 10 short bullets or sentences).',
    'Do not invent facts. If the transcript is thin, say what little is known.',
    '',
    `Meeting: ${options.meetingTitle}`,
  ];
  if (options.prepContext?.trim()) {
    sections.push('', 'Meeting prep:', options.prepContext.trim());
  }
  sections.push(
    '',
    'Transcript:',
    truncateTranscriptWindow(options.transcriptWindow) || '(empty)'
  );
  return sections.join('\n');
}

export async function summarizeLiveAssistMeeting(options: {
  meetingTitle: string;
  transcriptWindow: string;
  prepContext?: string | null;
}): Promise<string | null> {
  try {
    const result = await runPiAiOneShot(
      buildLiveAssistFarewellPrompt(options),
      'Write a concise meeting wrap-up. Do not invent facts.',
      configStore.getAll(),
      { maxTokens: 512, temperature: 0 }
    );
    const text = result.text.trim();
    return text || null;
  } catch (error) {
    logWarn('[LiveAssist] Farewell summarize failed:', error);
    return null;
  }
}

export async function answerLiveAssistQuestion(
  options: LiveAssistAnswerOptions
): Promise<string | null> {
  const config = configStore.getAll();
  options.onProgress?.('answering');

  try {
    const answerResult = await runPiAiStream(
      buildLiveAssistAnswerPrompt(options),
      'Answer concisely in at most 6 sentences. Do not invent facts. Use only the provided transcript and prep.',
      config,
      {
        maxTokens: 256,
        temperature: 0,
        onDelta: options.onDelta,
      }
    );
    const answer = answerResult.text.trim();
    return answer || null;
  } catch (error) {
    logWarn('[LiveAssist] Answer stream failed:', error);
    return null;
  }
}
