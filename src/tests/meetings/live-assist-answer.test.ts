import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_MCP_CALLS,
  answerLiveAssistQuestion,
  buildLiveAssistAnswerPlanPrompt,
} from '../../main/meetings/live-assist-answer';

const runPiAiOneShotMock = vi.hoisted(() => vi.fn());
const callToolMock = vi.hoisted(() => vi.fn());

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    getAll: () => ({ model: 'anthropic/claude-sonnet-5', provider: 'anthropic' }),
  },
}));

vi.mock('../../main/agent/sdk-one-shot', () => ({
  runPiAiOneShot: runPiAiOneShotMock,
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
    runPiAiOneShotMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          calls: [{ tool_name: 'mcp__Hub__list_projects', arguments: { limit: 5 } }],
        }),
      })
      .mockResolvedValueOnce({ text: 'Q3 revenue grew 12% to $4.2M.' });
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([{ name: 'Project A', revenue: '$4.2M' }]) }],
    });
  });

  it('plans MCP calls, executes in parallel, and summarizes', async () => {
    const mcpManager = makeMcpManager([
      { name: 'mcp__Hub__list_projects', serverName: 'Hub', description: 'List projects' },
    ]);

    const answer = await answerLiveAssistQuestion({
      question: 'What is our Q3 revenue?',
      transcriptWindow: 'Sam: What is our Q3 revenue?',
      meetingTitle: 'Finance sync',
      mcpManager: mcpManager as never,
    });

    expect(answer).toBe('Q3 revenue grew 12% to $4.2M.');
    expect(runPiAiOneShotMock).toHaveBeenCalledTimes(2);
    expect(callToolMock).toHaveBeenCalledWith('mcp__Hub__list_projects', { limit: 5 });
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

  it('skips unknown tools from the plan', async () => {
    runPiAiOneShotMock.mockReset();
    runPiAiOneShotMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          calls: [{ tool_name: 'mcp__Unknown__missing', arguments: {} }],
        }),
      })
      .mockResolvedValueOnce({ text: 'No internal data found.' });

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
});
