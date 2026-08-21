import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_CONTEXT_MANAGEMENT_BETA,
  injectAnthropicContextEditing,
  pruneMessagesForLiveTurn,
  supportsAnthropicContextEditing,
  withAnthropicContextManagementBeta,
} from '../../main/agent/live-context-prune';

describe('live-context-prune', () => {
  it('prunes old long tool results but keeps the most recent', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'toolResult', toolUseId: 'a', content: 'x'.repeat(2000) }],
      },
      {
        role: 'assistant',
        content: [{ type: 'toolResult', toolUseId: 'b', content: 'y'.repeat(2000) }],
      },
      {
        role: 'assistant',
        content: [{ type: 'toolResult', toolUseId: 'c', content: 'z'.repeat(2000) }],
      },
      {
        role: 'assistant',
        content: [{ type: 'toolResult', toolUseId: 'd', content: 'keep-me-long'.repeat(100) }],
      },
    ];

    const result = pruneMessagesForLiveTurn(messages, {
      pruneToolOutputAbove: 500,
      keepRecentToolResults: 1,
    });
    expect(result.prunedCount).toBe(3);
    expect(messages[0].content[0].content).toContain('Output truncated');
    expect(messages[3].content[0].content).toContain('keep-me-long');
  });

  it('injects Anthropic context_management clear_tool_uses', () => {
    const payload: Record<string, unknown> = { model: 'claude-sonnet-4-6', messages: [] };
    injectAnthropicContextEditing(payload);
    const cm = payload.context_management as {
      edits: Array<{ type: string; clear_at_least: { value: number } }>;
    };
    expect(cm.edits[0]?.type).toBe('clear_tool_uses_20250919');
    expect(cm.edits[0]?.clear_at_least.value).toBeGreaterThanOrEqual(15000);
  });

  it('does not overwrite existing context_management', () => {
    const payload: Record<string, unknown> = {
      context_management: { edits: [{ type: 'custom' }] },
    };
    injectAnthropicContextEditing(payload);
    expect((payload.context_management as { edits: unknown[] }).edits[0]).toEqual({
      type: 'custom',
    });
  });

  it('adds context-management beta header', () => {
    const headers = withAnthropicContextManagementBeta({ 'anthropic-beta': 'oauth-2025-04-20' });
    expect(headers['anthropic-beta']).toContain(ANTHROPIC_CONTEXT_MANAGEMENT_BETA);
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
  });

  it('detects anthropic-messages API', () => {
    expect(supportsAnthropicContextEditing('anthropic-messages')).toBe(true);
    expect(supportsAnthropicContextEditing('openai-completions')).toBe(false);
  });
});
