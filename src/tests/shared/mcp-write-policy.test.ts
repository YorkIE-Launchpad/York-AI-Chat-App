import { describe, expect, it } from 'vitest';
import {
  areMcpWritesEffectivelyAllowed,
  classifyMcpToolAccess,
  isMcpPrefixedTool,
  isMcpWriteTool,
  parseMcpToolName,
  sanitizeMcpToolSegment,
  shouldDenyMcpWriteAccess,
} from '../../shared/mcp-write-policy';

describe('mcp-write-policy', () => {
  describe('sanitizeMcpToolSegment / parseMcpToolName', () => {
    it('sanitizes server names like MCPManager', () => {
      expect(sanitizeMcpToolSegment('R&D Launchpad')).toBe('R_D_Launchpad');
      expect(sanitizeMcpToolSegment('York IE HUB')).toBe('York_IE_HUB');
      expect(sanitizeMcpToolSegment('Google Drive')).toBe('Google_Drive');
    });

    it('parses mcp__Server__leaf names', () => {
      expect(parseMcpToolName('mcp__Slack__post_message')).toEqual({
        serverKey: 'Slack',
        leafName: 'post_message',
      });
      expect(parseMcpToolName('mcp_call_tool')).toBeNull();
      expect(parseMcpToolName('write')).toBeNull();
    });
  });

  describe('classifyMcpToolAccess', () => {
    it('classifies first-party reads as read', () => {
      expect(classifyMcpToolAccess('mcp__Slack__list_channels')).toBe('read');
      expect(classifyMcpToolAccess('mcp__Gmail__search_emails')).toBe('read');
      expect(classifyMcpToolAccess('mcp__Google_Calendar__list_events')).toBe('read');
      expect(classifyMcpToolAccess('mcp__Jira__getJiraIssue')).toBe('read');
    });

    it('classifies first-party writes as write', () => {
      expect(classifyMcpToolAccess('mcp__Slack__post_message')).toBe('write');
      expect(classifyMcpToolAccess('mcp__Gmail__send_email')).toBe('write');
      expect(classifyMcpToolAccess('mcp__Google_Calendar__create_event')).toBe('write');
      expect(classifyMcpToolAccess('mcp__Jira__createJiraIssue')).toBe('write');
      expect(classifyMcpToolAccess('mcp__Confluence__updateConfluencePage')).toBe('write');
    });

    it('classifies Hub/Launchpad tools via leaf heuristics', () => {
      expect(classifyMcpToolAccess('mcp__York_IE_HUB__list_employees')).toBe('read');
      expect(classifyMcpToolAccess('mcp__York_IE_HUB__create_announcement')).toBe('write');
      expect(classifyMcpToolAccess('mcp__R_D_Launchpad__list_features')).toBe('read');
      expect(classifyMcpToolAccess('mcp__R_D_Launchpad__create_release')).toBe('write');
      expect(classifyMcpToolAccess('mcp__Hub__get_me')).toBe('read');
    });

    it('treats non-MCP names as unknown', () => {
      expect(classifyMcpToolAccess('write')).toBe('unknown');
      expect(classifyMcpToolAccess('mcp_call_tool')).toBe('unknown');
      expect(isMcpPrefixedTool('mcp_call_tool')).toBe(false);
    });
  });

  describe('effective allow / deny', () => {
    it('requires global and per-server both enabled', () => {
      expect(areMcpWritesEffectivelyAllowed(true, true)).toBe(true);
      expect(areMcpWritesEffectivelyAllowed(true, undefined)).toBe(true);
      expect(areMcpWritesEffectivelyAllowed(true, false)).toBe(false);
      expect(areMcpWritesEffectivelyAllowed(false, true)).toBe(false);
      expect(areMcpWritesEffectivelyAllowed(false, false)).toBe(false);
    });

    it('denies write tools when global is off', () => {
      expect(shouldDenyMcpWriteAccess('mcp__Slack__post_message', false, true)).toBe(true);
      expect(shouldDenyMcpWriteAccess('mcp__Slack__list_channels', false, true)).toBe(false);
      expect(shouldDenyMcpWriteAccess('write', false, true)).toBe(false);
    });

    it('denies write tools when per-server is off', () => {
      expect(shouldDenyMcpWriteAccess('mcp__Slack__post_message', true, false)).toBe(true);
      expect(shouldDenyMcpWriteAccess('mcp__Slack__list_channels', true, false)).toBe(false);
    });

    it('fail-closes unknown MCP tools when writes are disabled', () => {
      expect(isMcpWriteTool('mcp__Chrome__click')).toBe(true);
      expect(shouldDenyMcpWriteAccess('mcp__Chrome__click', false, true)).toBe(true);
      expect(shouldDenyMcpWriteAccess('mcp__Chrome__click', true, true)).toBe(false);
    });
  });
});
