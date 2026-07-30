import { describe, expect, it } from 'vitest';

import {
  INCOMPLETE_TURN_FAILURE_MESSAGE,
  buildIncompleteTurnSteerMessage,
  detectIncompleteTurn,
  isActionableUserPrompt,
  summarizeContentBlocks,
} from '../src/main/agent/incomplete-turn';

describe('isActionableUserPrompt', () => {
  it('detects send / post / create style requests', () => {
    expect(isActionableUserPrompt('send a slack message to jay gangani, hi from vecos')).toBe(true);
    expect(isActionableUserPrompt('Post this to #general')).toBe(true);
    expect(isActionableUserPrompt('create a Jira ticket for the bug')).toBe(true);
    expect(isActionableUserPrompt('update the calendar event')).toBe(true);
  });

  it('does not flag pure Q&A', () => {
    expect(isActionableUserPrompt('what slack tools do you have?')).toBe(false);
    expect(isActionableUserPrompt('how does leave policy work?')).toBe(false);
    expect(isActionableUserPrompt('')).toBe(false);
  });
});

describe('summarizeContentBlocks', () => {
  it('flags thinking-only content', () => {
    expect(
      summarizeContentBlocks([{ type: 'thinking', thinking: 'I should call post_message' }])
    ).toEqual({ hasText: false, hasThinking: true, hasToolUse: false });
  });

  it('flags text and tool_use', () => {
    expect(
      summarizeContentBlocks([{ type: 'text', text: 'Sending now' }, { type: 'tool_use' }])
    ).toEqual({ hasText: true, hasThinking: false, hasToolUse: true });
  });

  it('ignores empty text/thinking', () => {
    expect(
      summarizeContentBlocks([
        { type: 'text', text: '  ' },
        { type: 'thinking', thinking: '' },
      ])
    ).toEqual({
      hasText: false,
      hasThinking: false,
      hasToolUse: false,
    });
  });
});

describe('detectIncompleteTurn', () => {
  it('flags search without mcp_call_tool on actionable prompts', () => {
    const decision = detectIncompleteTurn({
      userPrompt: 'send a slack message to jay, hi',
      toolsInvoked: ['mcp_search_tools'],
      finalAssistant: { hasText: false, hasThinking: true, hasToolUse: false },
    });
    expect(decision).toEqual({ incomplete: true, reason: 'search_without_call' });
  });

  it('does not flag search when mcp_call_tool was used', () => {
    const decision = detectIncompleteTurn({
      userPrompt: 'send a slack message to jay, hi',
      toolsInvoked: ['mcp_search_tools', 'mcp_call_tool'],
      finalAssistant: { hasText: true, hasThinking: false, hasToolUse: false },
    });
    expect(decision.incomplete).toBe(false);
  });

  it('treats mcp_run as a successful follow-up to search', () => {
    const decision = detectIncompleteTurn({
      userPrompt: 'send a slack message',
      toolsInvoked: ['mcp_search_tools', 'mcp_run'],
      finalAssistant: { hasText: true, hasThinking: false, hasToolUse: false },
    });
    expect(decision.incomplete).toBe(false);
  });

  it('does not flag search-without-call for non-actionable Q&A', () => {
    const decision = detectIncompleteTurn({
      userPrompt: 'what slack tools do you have?',
      toolsInvoked: ['mcp_search_tools'],
      finalAssistant: { hasText: true, hasThinking: false, hasToolUse: false },
    });
    expect(decision.incomplete).toBe(false);
  });

  it('does not flag thinking-only after tools already ran', () => {
    const decision = detectIncompleteTurn({
      userPrompt: 'send a slack message',
      toolsInvoked: ['mcp_call_tool'],
      finalAssistant: { hasText: false, hasThinking: true, hasToolUse: false },
    });
    expect(decision.incomplete).toBe(false);
  });

  it('flags thinking-only final message on actionable prompts', () => {
    const decision = detectIncompleteTurn({
      userPrompt: 'email bob that the meeting is cancelled',
      toolsInvoked: [],
      finalAssistant: { hasText: false, hasThinking: true, hasToolUse: false },
    });
    expect(decision).toEqual({ incomplete: true, reason: 'thinking_only_actionable' });
  });

  it('does not flag thinking-only for non-actionable prompts', () => {
    const decision = detectIncompleteTurn({
      userPrompt: 'explain how OAuth works',
      toolsInvoked: [],
      finalAssistant: { hasText: false, hasThinking: true, hasToolUse: false },
    });
    expect(decision.incomplete).toBe(false);
  });

  it('matches tool names case-insensitively', () => {
    const decision = detectIncompleteTurn({
      userPrompt: 'send a message on slack',
      toolsInvoked: ['MCP_SEARCH_TOOLS'],
      finalAssistant: { hasText: false, hasThinking: false, hasToolUse: false },
    });
    expect(decision.reason).toBe('search_without_call');
  });
});

describe('buildIncompleteTurnSteerMessage', () => {
  it('mentions mcp_call_tool for search_without_call', () => {
    const text = buildIncompleteTurnSteerMessage('search_without_call');
    expect(text).toContain('mcp_call_tool');
    expect(text).toContain('mcp_search_tools');
  });

  it('mentions execute for thinking_only_actionable', () => {
    const text = buildIncompleteTurnSteerMessage('thinking_only_actionable');
    expect(text.toLowerCase()).toContain('execute');
  });
});

describe('INCOMPLETE_TURN_FAILURE_MESSAGE', () => {
  it('tells the user to continue', () => {
    expect(INCOMPLETE_TURN_FAILURE_MESSAGE.toLowerCase()).toContain('continue');
  });
});
