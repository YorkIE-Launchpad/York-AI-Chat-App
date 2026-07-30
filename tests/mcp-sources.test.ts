import { describe, expect, it } from 'vitest';
import type { Message } from '../src/renderer/types';
import {
  extractMcpSourcesFromTurn,
  messageHasSourcesSection,
  shouldShowMcpSourcesFooter,
} from '../src/renderer/utils/mcp-sources';

function msg(id: string, role: Message['role'], content: Message['content']): Message {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('messageHasSourcesSection', () => {
  it('detects a Sources section at the end of the answer', () => {
    expect(
      messageHasSourcesSection('Here is the answer.\n\nSources:\n- [Doc](https://example.com/doc)')
    ).toBe(true);
    expect(messageHasSourcesSection('Summary.\n\n## Sources\n- Hub employee list')).toBe(true);
  });

  it('ignores Sources mentioned mid-answer without a trailing section', () => {
    expect(
      messageHasSourcesSection(
        'I checked several sources of truth in Hub.\n\nThe leave balance is 12 days.'
      )
    ).toBe(false);
  });
});

describe('extractMcpSourcesFromTurn', () => {
  it('extracts unique URLs from MCP tool results', () => {
    const messages: Message[] = [
      msg('u1', 'user', [{ type: 'text', text: 'Find the doc' }]),
      msg('a1', 'assistant', [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'mcp__Google_Drive__search_files',
          input: { query: 'roadmap' },
        },
      ]),
      msg('a2', 'assistant', [
        {
          type: 'tool_result',
          toolUseId: 'tu1',
          content:
            'Found file\nLink: https://drive.google.com/file/d/abc\nAlso https://drive.google.com/file/d/abc',
        },
      ]),
      msg('a3', 'assistant', [{ type: 'text', text: 'Here is the roadmap.' }]),
    ];

    const sources = extractMcpSourcesFromTurn(messages, 'u1');
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('https://drive.google.com/file/d/abc');
    expect(sources[0].serverName).toBe('Google Drive');
  });

  it('falls back to connector names when MCP results have no URLs', () => {
    const messages: Message[] = [
      msg('u1', 'user', [{ type: 'text', text: 'Who is Jane?' }]),
      msg('a1', 'assistant', [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'mcp__York_Hub__list_employees',
          input: { query: 'Jane' },
        },
      ]),
      msg('a2', 'assistant', [
        {
          type: 'tool_result',
          toolUseId: 'tu1',
          content: 'Jane Doe — Engineering',
        },
      ]),
      msg('a3', 'assistant', [{ type: 'text', text: 'Jane is on Engineering.' }]),
    ];

    const sources = extractMcpSourcesFromTurn(messages, 'u1');
    expect(sources).toEqual([{ title: 'York Hub', serverName: 'York Hub' }]);
  });

  it('ignores non-MCP tools', () => {
    const messages: Message[] = [
      msg('u1', 'user', [{ type: 'text', text: 'Read file' }]),
      msg('a1', 'assistant', [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'Read',
          input: { path: 'a.ts' },
        },
      ]),
      msg('a2', 'assistant', [
        {
          type: 'tool_result',
          toolUseId: 'tu1',
          content: 'https://example.com/not-from-mcp',
        },
      ]),
      msg('a3', 'assistant', [{ type: 'text', text: 'Done.' }]),
    ];

    expect(extractMcpSourcesFromTurn(messages, 'u1')).toEqual([]);
  });
});

describe('shouldShowMcpSourcesFooter', () => {
  const baseMessages: Message[] = [
    msg('u1', 'user', [{ type: 'text', text: 'Find the doc' }]),
    msg('a1', 'assistant', [
      {
        type: 'tool_use',
        id: 'tu1',
        name: 'mcp__Slack__search_messages',
        input: { query: 'promise' },
      },
    ]),
    msg('a2', 'assistant', [
      {
        type: 'tool_result',
        toolUseId: 'tu1',
        content: 'hit\nLink: https://app.slack.com/archives/C123/p123',
      },
    ]),
    msg('a3', 'assistant', [{ type: 'text', text: 'Jay promised to send the deck.' }]),
  ];

  it('shows on the last assistant text message when Sources is missing', () => {
    const result = shouldShowMcpSourcesFooter({
      messages: baseMessages,
      messageId: 'a3',
    });
    expect(result.show).toBe(true);
    expect(result.sources[0].url).toContain('slack.com');
  });

  it('hides when the answer already has a Sources section', () => {
    const messages = [
      ...baseMessages.slice(0, 3),
      msg('a3', 'assistant', [
        {
          type: 'text',
          text: 'Jay promised to send the deck.\n\nSources:\n- [Slack](https://app.slack.com/archives/C123/p123)',
        },
      ]),
    ];
    expect(shouldShowMcpSourcesFooter({ messages, messageId: 'a3' }).show).toBe(false);
  });

  it('hides while streaming and on non-final messages', () => {
    expect(
      shouldShowMcpSourcesFooter({
        messages: baseMessages,
        messageId: 'a3',
        isStreaming: true,
      }).show
    ).toBe(false);
    expect(
      shouldShowMcpSourcesFooter({
        messages: baseMessages,
        messageId: 'a1',
      }).show
    ).toBe(false);
  });
});
