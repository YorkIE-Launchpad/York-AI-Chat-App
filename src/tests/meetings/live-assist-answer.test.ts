import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_MCP_CALLS,
  answerLiveAssistQuestion,
  buildLiveAssistAnswerPlanPrompt,
  buildLiveAssistAnswerPrompt,
  buildLiveAssistFarewellPrompt,
  summarizeLiveAssistMeeting,
} from '../../main/meetings/live-assist-answer';

const runPiAiOneShotMock = vi.hoisted(() => vi.fn());
const runPiAiStreamMock = vi.hoisted(() => vi.fn());
const callToolMock = vi.hoisted(() => vi.fn());

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    getAll: () => ({ model: 'anthropic/claude-sonnet-5', provider: 'anthropic' }),
  },
}));

vi.mock('../../main/agent/sdk-one-shot', () => ({
  runPiAiOneShot: runPiAiOneShotMock,
  runPiAiStream: runPiAiStreamMock,
}));

function makeMcpManager(tools: Array<{ name: string; serverName: string; description?: string }>) {
  return {
    getTools: () =>
      tools.map((tool) => ({
        name: tool.name,
        serverName: tool.serverName,
        description: tool.description || '',
        inputSchema: { type: 'object', properties: {} },
      })),
    callTool: callToolMock,
  };
}

describe('live-assist-answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPiAiOneShotMock.mockResolvedValueOnce({
      text: JSON.stringify({
        calls: [{ tool_name: 'mcp__Hub__list_projects', arguments: { limit: 5 } }],
      }),
    });
    runPiAiStreamMock.mockResolvedValue({ text: 'Q3 revenue grew 12% to $4.2M.' });
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([{ name: 'Project A', revenue: '$4.2M' }]) }],
    });
  });

  it('plans MCP calls, executes them, then streams the answer', async () => {
    const onProgress = vi.fn();
    const onDelta = vi.fn();
    const mcpManager = makeMcpManager([
      { name: 'mcp__Hub__list_projects', serverName: 'Hub', description: 'List projects' },
    ]);

    const answer = await answerLiveAssistQuestion({
      question: 'What is our Q3 revenue?',
      transcriptWindow: 'Sam: What is our Q3 revenue?',
      meetingTitle: 'Finance sync',
      mcpManager: mcpManager as never,
      onProgress,
      onDelta,
    });

    expect(answer).toBe('Q3 revenue grew 12% to $4.2M.');
    expect(runPiAiOneShotMock).toHaveBeenCalledTimes(1);
    expect(runPiAiStreamMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith('mcp__Hub__list_projects', { limit: 5 });
    expect(onProgress).toHaveBeenCalledWith('planning');
    expect(onProgress).toHaveBeenCalledWith('mcp', 'mcp__Hub__list_projects');
    expect(onProgress).toHaveBeenCalledWith('answering');
    expect(runPiAiStreamMock.mock.calls[0]?.[3]?.onDelta).toBe(onDelta);
  });

  it('caps planned MCP calls at MAX_MCP_CALLS', () => {
    const prompt = buildLiveAssistAnswerPlanPrompt(
      {
        question: 'Who leads project X?',
        transcriptWindow: 'Who leads project X?',
        meetingTitle: 'Sync',
        mcpManager: makeMcpManager([]) as never,
      },
      '- tool_a (Hub): desc'
    );
    expect(prompt).toContain(String(MAX_MCP_CALLS));
  });

  it('skips unknown tools from the plan and still streams an answer', async () => {
    runPiAiOneShotMock.mockReset();
    runPiAiOneShotMock.mockResolvedValueOnce({
      text: JSON.stringify({
        calls: [{ tool_name: 'mcp__Unknown__missing', arguments: {} }],
      }),
    });
    runPiAiStreamMock.mockResolvedValueOnce({ text: 'No internal data found.' });

    const mcpManager = makeMcpManager([
      { name: 'mcp__Hub__list_projects', serverName: 'Hub' },
    ]);

    const answer = await answerLiveAssistQuestion({
      question: 'What is our Q3 revenue?',
      transcriptWindow: 'Sam: What is our Q3 revenue?',
      meetingTitle: 'Finance sync',
      mcpManager: mcpManager as never,
    });

    expect(answer).toBe('No internal data found.');
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('builds answer prompt with research results', () => {
    const prompt = buildLiveAssistAnswerPrompt(
      {
        question: 'What is our Q3 revenue?',
        transcriptWindow: 'Sam: What is our Q3 revenue?',
        meetingTitle: 'Finance sync',
        prepContext: 'Bring Q3 numbers',
        mcpManager: makeMcpManager([]) as never,
      },
      [{ tool: 'mcp__Hub__list_projects', text: 'Project A: $1.2M' }]
    );
    expect(prompt).toContain('What is our Q3 revenue?');
    expect(prompt).toContain('mcp__Hub__list_projects');
    expect(prompt).toContain('Project A: $1.2M');
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

    runPiAiOneShotMock.mockReset();
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
