import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerLiveAssistQuestion,
  buildLiveAssistAnswerPrompt,
  buildLiveAssistFarewellPrompt,
  summarizeLiveAssistMeeting,
} from '../../main/meetings/live-assist-answer';

const runPiAiOneShotMock = vi.hoisted(() => vi.fn());
const runPiAiStreamMock = vi.hoisted(() => vi.fn());

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    getAll: () => ({ model: 'anthropic/claude-sonnet-5', provider: 'anthropic' }),
  },
}));

vi.mock('../../main/agent/sdk-one-shot', () => ({
  runPiAiOneShot: runPiAiOneShotMock,
  runPiAiStream: runPiAiStreamMock,
}));

describe('live-assist-answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPiAiStreamMock.mockResolvedValue({ text: 'Q3 revenue grew 12% to $4.2M.' });
  });

  it('answers with a single streamed LLM call and no MCP', async () => {
    const onProgress = vi.fn();
    const onDelta = vi.fn();

    const answer = await answerLiveAssistQuestion({
      question: 'What is our Q3 revenue?',
      transcriptWindow: 'Sam: What is our Q3 revenue?',
      meetingTitle: 'Finance sync',
      prepContext: 'Bring Q3 numbers',
      onProgress,
      onDelta,
    });

    expect(answer).toBe('Q3 revenue grew 12% to $4.2M.');
    expect(runPiAiStreamMock).toHaveBeenCalledTimes(1);
    expect(runPiAiOneShotMock).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith('answering');
    expect(runPiAiStreamMock.mock.calls[0]?.[3]?.onDelta).toBe(onDelta);
  });

  it('builds answer prompt from transcript and prep only', () => {
    const prompt = buildLiveAssistAnswerPrompt({
      question: 'Who leads project X?',
      transcriptWindow: 'Who leads project X?',
      meetingTitle: 'Sync',
      prepContext: 'Project X owners',
      customInstructions: 'Be brief',
    });
    expect(prompt).toContain('Who leads project X?');
    expect(prompt).toContain('Project X owners');
    expect(prompt).toContain('Be brief');
    expect(prompt).not.toContain('MCP');
    expect(prompt).not.toContain('tool_name');
  });

  it('builds farewell prompt with transcript and summarizes', async () => {
    const prompt = buildLiveAssistFarewellPrompt({
      meetingTitle: 'Weekly sync',
      transcriptWindow: 'Sam: ship by Friday?\nAlex: yes.',
      prepContext: 'Roadmap review',
    });
    expect(prompt).toContain('Weekly sync');
    expect(prompt).toContain('ship by Friday');
    expect(prompt).toContain('Roadmap review');

    runPiAiOneShotMock.mockResolvedValueOnce({
      text: 'Follow-up: confirm Friday ship.',
    });
    const summary = await summarizeLiveAssistMeeting({
      meetingTitle: 'Weekly sync',
      transcriptWindow: 'Sam: ship by Friday?\nAlex: yes.',
    });
    expect(summary).toBe('Follow-up: confirm Friday ship.');
  });
});
