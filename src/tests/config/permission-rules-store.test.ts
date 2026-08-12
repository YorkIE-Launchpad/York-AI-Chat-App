/**
 * Tests for src/main/config/permission-rules-store.
 *
 * Focus areas (security-critical):
 *   - decidePermission() returns allow / deny / ask per rule
 *   - Glob-ish pattern matching ('*' = any substring) and case-insensitivity
 *   - Session-scoped "always allow" memory works within session and clears on
 *     forgetSessionPermissions()
 *   - Built-in Chrome MCP (`mcp__Chrome__*`), R&D Launchpad MCP (`mcp__R_D_Launchpad__*` /
 *     legacy `mcp__Launchpad__*`), York IE HUB MCP (`mcp__York_IE_HUB__*` / legacy `mcp__Hub__*`),
 *     GTM Pulse MCP (`mcp__GTM_Pulse__*`), OpenAI meta-tools (`mcp_run`, `mcp_search_tools`, `mcp_call_tool`),
 *     meeting tools (`meeting_search`, `meeting_read`), wiki tools (`wiki_search`,
 *     `wiki_read`, `wiki_list`), and `webfetch` auto-allow, overridable by rules
 *   - Garbage / malformed renderer input falls back to DEFAULT_RULES so the
 *     fail-safe is an extra prompt, never a silent auto-allow
 *   - Malformed individual rule entries are coerced to 'ask' rather than
 *     silently bypassed
 */
import { beforeEach, describe, it, expect } from 'vitest';
import {
  decidePermission,
  forgetSessionPermissions,
  getPermissionRules,
  rememberAlwaysAllow,
  setPermissionRules,
} from '../../main/config/permission-rules-store';
import {
  setMcpWriteAccessEnabled,
  setMcpWriteAccessServerSource,
} from '../../main/config/mcp-write-access-store';

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

// Reset to DEFAULT_RULES before each test by passing garbage input — the
// module documents that this falls back to defaults rather than empty rules.
function resetToDefaults(): void {
  setPermissionRules(null);
  forgetSessionPermissions(SESSION_A);
  forgetSessionPermissions(SESSION_B);
  setMcpWriteAccessEnabled(true);
  setMcpWriteAccessServerSource(() => []);
}

describe('permission-rules-store', () => {
  beforeEach(() => {
    resetToDefaults();
  });

  describe('decidePermission — built-in defaults', () => {
    it('returns allow for default-allowed read tool', () => {
      expect(decidePermission(SESSION_A, 'read', { path: '/tmp/x' })).toBe('allow');
    });

    it('returns ask for default-ask bash tool', () => {
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('ask');
    });

    it('returns ask for default-ask write tool', () => {
      expect(decidePermission(SESSION_A, 'write', { path: '/etc/passwd' })).toBe('ask');
    });

    it('returns ask for unknown tool (conservative default)', () => {
      expect(decidePermission(SESSION_A, 'unknown_tool', {})).toBe('ask');
    });

    it('matches tool names case-insensitively', () => {
      expect(decidePermission(SESSION_A, 'READ', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'BaSh', { command: 'ls' })).toBe('ask');
    });

    it('returns allow for Chrome MCP tools by default', () => {
      expect(
        decidePermission(SESSION_A, 'mcp__Chrome__new_page', {
          url: 'https://www.google.com',
        })
      ).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__chrome__navigate_page', {})).toBe('allow');
    });

    it('returns allow for R&D Launchpad MCP tools by default (new + legacy names)', () => {
      expect(decidePermission(SESSION_A, 'mcp__R_D_Launchpad__list_projects', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__r_d_launchpad__get_me', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Launchpad__list_projects', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__launchpad__get_me', {})).toBe('allow');
    });

    it('returns allow for R&D Pulse MCP tools by default', () => {
      expect(decidePermission(SESSION_A, 'mcp__R_D_Pulse__list_items', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__r_d_pulse__get_me', {})).toBe('allow');
    });

    it('returns allow for York IE HUB MCP tools by default (new + legacy names)', () => {
      expect(decidePermission(SESSION_A, 'mcp__York_IE_HUB__list_employees', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__york_ie_hub__get_me', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Hub__list_employees', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__hub__get_me', {})).toBe('allow');
    });

    it('returns allow for GTM Pulse MCP tools by default', () => {
      expect(decidePermission(SESSION_A, 'mcp__GTM_Pulse__get_data_availability', {})).toBe(
        'allow'
      );
      expect(decidePermission(SESSION_A, 'mcp__gtm_pulse__list_projects', {})).toBe('allow');
    });

    it('returns allow for Slack/Gmail/Drive/Calendar/Jira/Confluence read tools by default', () => {
      expect(decidePermission(SESSION_A, 'mcp__Slack__list_channels', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Slack__get_channel_history', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Slack__search_messages', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Slack__get_thread', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Slack__get_user', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Gmail__search_emails', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Gmail__get_email', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Gmail__list_labels', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Drive__search_files', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Drive__list_files', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Drive__get_file_metadata', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Drive__get_document_content', {})).toBe(
        'allow'
      );
      expect(decidePermission(SESSION_A, 'mcp__Google_Drive__get_spreadsheet_values', {})).toBe(
        'allow'
      );
      expect(decidePermission(SESSION_A, 'mcp__Jira__getJiraIssue', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Jira__searchJiraIssuesUsingJql', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Jira__atlassianUserInfo', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Jira__getAccessibleAtlassianResources', {})).toBe(
        'allow'
      );
      expect(decidePermission(SESSION_A, 'mcp__Confluence__getConfluencePage', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Confluence__searchConfluenceUsingCql', {})).toBe(
        'allow'
      );
      expect(decidePermission(SESSION_A, 'mcp__Confluence__atlassianUserInfo', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Calendar__list_events', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Calendar__search_events', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Calendar__get_event', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Calendar__list_calendars', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__Google_Calendar__query_freebusy', {})).toBe('allow');
    });

    it('returns ask for Slack and Gmail write tools by default', () => {
      expect(decidePermission(SESSION_A, 'mcp__Slack__post_message', { channel: 'general' })).toBe(
        'ask'
      );
      expect(decidePermission(SESSION_A, 'mcp__Gmail__send_email', { to: 'a@b.com' })).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Gmail__create_draft', { body: 'hi' })).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Gmail__update_draft', { draft_id: 'r1', body: 'hi' })
      ).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Gmail__send_draft', { draft_id: 'd1' })).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Gmail__modify_email_labels', {
          message_id: 'm1',
          remove_label_ids: ['INBOX'],
        })
      ).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Gmail__trash_email', { message_id: 'm1' })).toBe(
        'ask'
      );
    });

    it('returns ask for Drive and Calendar write tools by default', () => {
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__create_document', { title: 'Notes' })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__update_document_content', {
          file_id: 'abc',
          body: 'hi',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__create_folder', { name: 'Folder' })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__create_spreadsheet', {
          title: 'Budget',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__update_spreadsheet_values', {
          file_id: 'sheet1',
          range: 'A1',
          values: [['a']],
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__append_spreadsheet_values', {
          file_id: 'sheet1',
          range: 'A1',
          values: [['b']],
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__clear_spreadsheet_values', {
          file_id: 'sheet1',
          range: 'A1:B2',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__add_sheet', {
          file_id: 'sheet1',
          title: 'Q2',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__append_document_content', {
          file_id: 'doc1',
          body: 'more',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__rename_file', {
          file_id: 'f1',
          name: 'New',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__move_file', {
          file_id: 'f1',
          parent_folder_id: 'folder1',
        })
      ).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Google_Drive__trash_file', { file_id: 'f1' })).toBe(
        'ask'
      );
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__share_file', {
          file_id: 'f1',
          email: 'a@york.ie',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Drive__upload_file', {
          name: 'notes.txt',
          content: 'hi',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Calendar__create_event', {
          summary: 'Sync',
          start: '2026-08-01T10:00:00Z',
          end: '2026-08-01T11:00:00Z',
        })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Calendar__update_event', { event_id: 'evt1' })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Calendar__delete_event', { event_id: 'evt1' })
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Google_Calendar__respond_to_event', {
          event_id: 'evt1',
          response_status: 'accepted',
        })
      ).toBe('ask');
    });

    it('returns ask for Jira and Confluence write tools by default', () => {
      expect(decidePermission(SESSION_A, 'mcp__Jira__createJiraIssue', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Jira__editJiraIssue', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Jira__transitionJiraIssue', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Jira__addCommentToJiraIssue', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Jira__addWorklogToJiraIssue', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Confluence__createConfluencePage', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__Confluence__updateConfluencePage', {})).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Confluence__createConfluenceFooterComment', {})
      ).toBe('ask');
      expect(
        decidePermission(SESSION_A, 'mcp__Confluence__createConfluenceInlineComment', {})
      ).toBe('ask');
    });

    it('returns allow for OpenAI budget meta-tools by default', () => {
      expect(decidePermission(SESSION_A, 'mcp_run', { goal: 'list leave' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp_search_tools', { query: 'employee' })).toBe('allow');
      expect(
        decidePermission(SESSION_A, 'mcp_call_tool', {
          tool_name: 'mcp__York_IE_HUB__list_employees',
          arguments: { limit: 10 },
        })
      ).toBe('allow');
      expect(
        decidePermission(SESSION_A, 'mcp_call_tool', {
          tool_name: 'mcp__Notion__search',
          arguments: { query: 'docs' },
        })
      ).toBe('allow');
    });

    it('returns allow for webfetch by default', () => {
      expect(decidePermission(SESSION_A, 'webfetch', { url: 'https://example.com' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'WebFetch', { url: 'https://example.com' })).toBe('allow');
    });

    it('returns allow for meeting tools by default', () => {
      expect(decidePermission(SESSION_A, 'meeting_search', { query: 'standup' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'meeting_read', { id: 'm1' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'Meeting_Search', { query: 'standup' })).toBe('allow');
    });

    it('returns allow for wiki tools by default', () => {
      expect(decidePermission(SESSION_A, 'wiki_search', { query: 'acme' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'wiki_read', { path: 'clients/acme' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'wiki_list', { pathPrefix: 'clients' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'Wiki_Search', { query: 'acme' })).toBe('allow');
    });

    it('returns ask for non-builtin MCP tools by default', () => {
      expect(decidePermission(SESSION_A, 'mcp__Notion__search', {})).toBe('ask');
    });
  });

  describe('decidePermission — MCP write kill-switch', () => {
    it('hard-denies connector writes when global write access is off', () => {
      setMcpWriteAccessEnabled(false);
      expect(decidePermission(SESSION_A, 'mcp__Slack__post_message', {})).toBe('deny');
      expect(decidePermission(SESSION_A, 'mcp__Google_Calendar__create_event', {})).toBe('deny');
      expect(decidePermission(SESSION_A, 'mcp__York_IE_HUB__create_announcement', {})).toBe('deny');
      expect(decidePermission(SESSION_A, 'mcp__R_D_Launchpad__create_release', {})).toBe('deny');
    });

    it('still allows connector reads when global write access is off', () => {
      setMcpWriteAccessEnabled(false);
      expect(decidePermission(SESSION_A, 'mcp__Slack__list_channels', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__York_IE_HUB__list_employees', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'mcp__R_D_Launchpad__list_features', {})).toBe('allow');
    });

    it('does not change local coding tool permissions when write access is off', () => {
      setMcpWriteAccessEnabled(false);
      expect(decidePermission(SESSION_A, 'read', { path: '/tmp/x' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'write', { path: '/tmp/x' })).toBe('ask');
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('ask');
    });

    it('hard-denies writes for a server with writeEnabled false', () => {
      setMcpWriteAccessServerSource(() => [{ name: 'Slack', writeEnabled: false }]);
      expect(decidePermission(SESSION_A, 'mcp__Slack__post_message', {})).toBe('deny');
      expect(decidePermission(SESSION_A, 'mcp__Slack__list_channels', {})).toBe('allow');
      // Other connectors still ask (not deny) for writes
      expect(decidePermission(SESSION_A, 'mcp__Gmail__send_email', {})).toBe('ask');
    });

    it('beats session always-allow for denied MCP writes', () => {
      rememberAlwaysAllow(SESSION_A, 'mcp__Slack__post_message');
      setMcpWriteAccessEnabled(false);
      expect(decidePermission(SESSION_A, 'mcp__Slack__post_message', {})).toBe('deny');
    });
  });

  describe('setPermissionRules — explicit rules', () => {
    it('returns allow when matching allow rule is set', () => {
      setPermissionRules([{ tool: 'bash', action: 'allow' }]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'rm -rf /' })).toBe('allow');
    });

    it('returns deny when matching deny rule is set', () => {
      setPermissionRules([{ tool: 'bash', action: 'deny' }]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('deny');
    });

    it('returns ask when matching ask rule is set', () => {
      setPermissionRules([{ tool: 'bash', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('ask');
    });

    it('falls through to default ask when no rule matches the tool', () => {
      setPermissionRules([{ tool: 'read', action: 'allow' }]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('ask');
    });

    it('explicit ask rule for a Chrome tool overrides the built-in allow', () => {
      setPermissionRules([{ tool: 'mcp__Chrome__new_page', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'mcp__Chrome__new_page', { url: 'https://x.com' })).toBe(
        'ask'
      );
      // Other Chrome tools still use the built-in allow
      expect(decidePermission(SESSION_A, 'mcp__Chrome__navigate_page', {})).toBe('allow');
    });

    it('explicit ask rule for an R&D Launchpad tool overrides the built-in allow', () => {
      setPermissionRules([{ tool: 'mcp__R_D_Launchpad__list_projects', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'mcp__R_D_Launchpad__list_projects', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__R_D_Launchpad__get_me', {})).toBe('allow');
    });

    it('explicit ask rule for a York IE HUB tool overrides the built-in allow', () => {
      setPermissionRules([{ tool: 'mcp__York_IE_HUB__list_employees', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'mcp__York_IE_HUB__list_employees', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__York_IE_HUB__get_me', {})).toBe('allow');
    });

    it('explicit ask rule for a GTM Pulse tool overrides the built-in allow', () => {
      setPermissionRules([{ tool: 'mcp__GTM_Pulse__get_data_availability', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'mcp__GTM_Pulse__get_data_availability', {})).toBe('ask');
      expect(decidePermission(SESSION_A, 'mcp__GTM_Pulse__list_projects', {})).toBe('allow');
    });

    it('explicit ask rule for a connector tool overrides the built-in allow', () => {
      setPermissionRules([{ tool: 'mcp__Google_Drive__get_document_content', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'mcp__Google_Drive__get_document_content', {})).toBe(
        'ask'
      );
      expect(decidePermission(SESSION_A, 'mcp__Google_Drive__search_files', {})).toBe('allow');
    });

    it('explicit ask rule for webfetch overrides the built-in allow', () => {
      setPermissionRules([{ tool: 'webfetch', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'webfetch', { url: 'https://example.com' })).toBe('ask');
    });

    it('explicit ask rule for a meeting tool overrides the built-in allow', () => {
      setPermissionRules([{ tool: 'meeting_search', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'meeting_search', { query: 'standup' })).toBe('ask');
      expect(decidePermission(SESSION_A, 'meeting_read', { id: 'm1' })).toBe('allow');
    });

    it('explicit ask rule for a wiki tool overrides the built-in allow', () => {
      setPermissionRules([{ tool: 'wiki_search', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'wiki_search', { query: 'acme' })).toBe('ask');
      expect(decidePermission(SESSION_A, 'wiki_read', { path: 'clients/acme' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'wiki_list', {})).toBe('allow');
    });
  });

  describe('pattern matching', () => {
    it("rule for 'bash' with pattern 'ls *' allows 'ls -la' but not 'rm -rf'", () => {
      setPermissionRules([
        { tool: 'bash', pattern: 'ls *', action: 'allow' },
        { tool: 'bash', action: 'ask' },
      ]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls -la' })).toBe('allow');
      expect(decidePermission(SESSION_A, 'bash', { command: 'rm -rf /tmp' })).toBe('ask');
    });

    it('uses first matching rule (rules are evaluated in order)', () => {
      setPermissionRules([
        { tool: 'bash', pattern: 'rm *', action: 'deny' },
        { tool: 'bash', action: 'allow' },
      ]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'rm -rf /' })).toBe('deny');
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('allow');
    });

    it('treats * as any substring (not just trailing wildcards)', () => {
      setPermissionRules([{ tool: 'bash', pattern: '*sudo*', action: 'deny' }]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'echo hi | sudo tee f' })).toBe('deny');
      expect(decidePermission(SESSION_A, 'bash', { command: 'echo hi' })).toBe('ask');
    });

    it('escapes regex metacharacters in patterns (security: prevents injection)', () => {
      // '.' in pattern must match literal '.', not any char
      setPermissionRules([{ tool: 'bash', pattern: 'rm a.txt', action: 'deny' }]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'rm a.txt' })).toBe('deny');
      // Should NOT match because the '.' is escaped to a literal dot
      expect(decidePermission(SESSION_A, 'bash', { command: 'rm aXtxt' })).toBe('ask');
    });

    it('falls through when pattern does not match', () => {
      setPermissionRules([
        { tool: 'bash', pattern: 'ls *', action: 'allow' },
        // No catch-all → falls through to module default ('ask')
      ]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'cat /etc/passwd' })).toBe('ask');
    });

    it('matches pattern against stringified JSON input for non-bash tools', () => {
      setPermissionRules([
        { tool: 'write', pattern: '*sensitive*', action: 'deny' },
        { tool: 'write', action: 'allow' },
      ]);
      expect(decidePermission(SESSION_A, 'write', { path: '/sensitive/data.json' })).toBe('deny');
      expect(decidePermission(SESSION_A, 'write', { path: '/tmp/ok.txt' })).toBe('allow');
    });
  });

  describe('session-scoped always-allow', () => {
    it('rememberAlwaysAllow makes future calls allow within the same session', () => {
      setPermissionRules([{ tool: 'bash', action: 'ask' }]);
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('ask');
      rememberAlwaysAllow(SESSION_A, 'bash');
      expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('allow');
    });

    it('always-allow does NOT leak to other sessions', () => {
      setPermissionRules([{ tool: 'bash', action: 'ask' }]);
      rememberAlwaysAllow(SESSION_A, 'bash');
      // Same tool, different session — must still ask
      expect(decidePermission(SESSION_B, 'bash', { command: 'ls' })).toBe('ask');
    });

    it('forgetSessionPermissions clears session-scoped allow memory', () => {
      setPermissionRules([{ tool: 'bash', action: 'ask' }]);
      rememberAlwaysAllow(SESSION_A, 'bash');
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('allow');
      forgetSessionPermissions(SESSION_A);
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('ask');
    });

    it('always-allow is case-insensitive (normalized to lowercase)', () => {
      setPermissionRules([{ tool: 'bash', action: 'ask' }]);
      rememberAlwaysAllow(SESSION_A, 'BASH');
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'Bash', {})).toBe('allow');
    });

    it('always-allow takes precedence over a configured deny rule', () => {
      // Security note: this matches the documented matching order (session
      // memory first, then rules). If this behaviour ever needs to change
      // for security reasons, this test should fail loudly.
      setPermissionRules([{ tool: 'bash', action: 'deny' }]);
      rememberAlwaysAllow(SESSION_A, 'bash');
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('allow');
    });
  });

  describe('fail-safe input sanitation', () => {
    it('falls back to DEFAULT_RULES when given null', () => {
      setPermissionRules(null);
      // read is in defaults as 'allow'
      expect(decidePermission(SESSION_A, 'read', {})).toBe('allow');
      // bash is in defaults as 'ask'
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('ask');
    });

    it('falls back to DEFAULT_RULES when given non-array', () => {
      setPermissionRules({ not: 'an-array' });
      expect(decidePermission(SESSION_A, 'read', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('ask');
    });

    it('falls back to DEFAULT_RULES when array sanitises to empty', () => {
      // All entries are garbage (no tool field) → sanitised list is empty →
      // fall back to defaults so we never run with an "allow everything"
      // empty ruleset.
      setPermissionRules([{ notTool: 'bash' }, null, 'string', 42]);
      expect(decidePermission(SESSION_A, 'read', {})).toBe('allow');
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('ask');
    });

    it('coerces unknown action values to ask (never silently auto-allows)', () => {
      setPermissionRules([{ tool: 'bash', action: 'YOLO' }]);
      // Action 'YOLO' is invalid → coerced to 'ask'
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('ask');
    });

    it('drops rules with empty / whitespace tool names', () => {
      setPermissionRules([
        { tool: '   ', action: 'allow' },
        { tool: '', action: 'allow' },
        { tool: 'read', action: 'allow' },
      ]);
      // The two garbage entries are dropped; the read entry survives
      const rules = getPermissionRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].tool).toBe('read');
    });

    it('coerces non-string pattern to undefined (no crash)', () => {
      setPermissionRules([{ tool: 'bash', pattern: 123 as unknown as string, action: 'allow' }]);
      // Pattern was non-string → dropped; rule applies unconditionally
      expect(decidePermission(SESSION_A, 'bash', { command: 'rm -rf /' })).toBe('allow');
    });

    it('mixes valid + garbage rules: keeps the valid ones, drops the rest', () => {
      setPermissionRules([
        { tool: 'bash', action: 'deny' },
        null,
        { notTool: 'foo' },
        { tool: '', action: 'allow' },
        { tool: 'read', action: 'allow' },
      ]);
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('deny');
      expect(decidePermission(SESSION_A, 'read', {})).toBe('allow');
    });
  });

  describe('getPermissionRules', () => {
    it('returns defaults after reset', () => {
      const rules = getPermissionRules();
      const tools = rules.map((r) => r.tool);
      expect(tools).toContain('read');
      expect(tools).toContain('bash');
    });

    it('returns shallow copies so callers cannot mutate the internal cache', () => {
      setPermissionRules([{ tool: 'bash', action: 'allow' }]);
      const rules = getPermissionRules();
      rules[0].action = 'deny';
      // Internal cache should be unaffected
      expect(decidePermission(SESSION_A, 'bash', {})).toBe('allow');
    });
  });
});
