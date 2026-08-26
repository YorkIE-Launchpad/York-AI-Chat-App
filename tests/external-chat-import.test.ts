import { describe, expect, it } from 'vitest';
import {
  convertChatGptConversations,
  convertClaudeConversations,
  convertMarkdownTranscript,
} from '../src/main/session/external-chat-import';

describe('external-chat-import', () => {
  it('converts a minimal ChatGPT conversations.json mapping', () => {
    const data = [
      {
        title: 'Project hours',
        mapping: {
          root: { id: 'root', parent: null, children: ['u1'] },
          u1: {
            id: 'u1',
            parent: 'root',
            children: ['a1'],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Show last 10 hours logged'] },
              create_time: 1700000000,
            },
          },
          a1: {
            id: 'a1',
            parent: 'u1',
            children: [],
            message: {
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Here are the entries.'] },
              create_time: 1700000001,
            },
          },
        },
      },
    ];

    const payloads = convertChatGptConversations(data);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].session.title).toBe('Project hours');
    expect(payloads[0].messages).toHaveLength(2);
    expect(payloads[0].messages[0].role).toBe('user');
    expect(payloads[0].messages[0].content).toEqual([
      { type: 'text', text: 'Show last 10 hours logged' },
    ]);
    expect(payloads[0].messages[1].role).toBe('assistant');
    expect(payloads[0].traceSteps).toEqual([]);
  });

  it('converts a minimal Claude chat_messages export', () => {
    const data = [
      {
        name: 'Timesheet thread',
        chat_messages: [
          { sender: 'human', text: 'Last 24 hours logged on Alpha', created_at: '2024-01-01T10:00:00Z' },
          {
            sender: 'assistant',
            content: [{ type: 'text', text: 'Accumulating recent rows…' }],
            created_at: '2024-01-01T10:00:05Z',
          },
        ],
      },
    ];

    const payloads = convertClaudeConversations(data);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].session.title).toBe('Timesheet thread');
    expect(payloads[0].messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(payloads[0].messages[1].content[0]).toEqual({
      type: 'text',
      text: 'Accumulating recent rows…',
    });
  });

  it('converts a Markdown transcript with speaker labels', () => {
    const md = `User: What is Matter?

Assistant: Matter is your personal radar.

Human: Thanks
Claude: You're welcome.`;

    const payload = convertMarkdownTranscript(md, 'Matter FAQ');
    expect(payload).not.toBeNull();
    expect(payload!.session.title).toBe('Matter FAQ');
    expect(payload!.messages).toHaveLength(4);
    expect(payload!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('falls back to a single user message when no speakers are found', () => {
    const payload = convertMarkdownTranscript('Just some notes without labels.', 'Notes');
    expect(payload).not.toBeNull();
    expect(payload!.messages).toHaveLength(1);
    expect(payload!.messages[0].role).toBe('user');
  });
});
