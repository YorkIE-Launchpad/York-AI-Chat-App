import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetSessionPermissions,
  isStrictRemoteSession,
  markStrictRemoteSession,
  rememberAlwaysAllow,
  rememberAutoApproveToolPermissions,
  resolveSessionToolPermission,
  sessionAutoApprovesToolPermissions,
  setPermissionRules,
  unmarkStrictRemoteSession,
} from '../../main/config/permission-rules-store';

const STRICT = 'strict-remote-session';

afterEach(() => {
  unmarkStrictRemoteSession(STRICT);
  forgetSessionPermissions(STRICT);
  setPermissionRules(null);
});

describe('strict remote sessions', () => {
  it('resolve tools exactly like desktop chats', () => {
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    markStrictRemoteSession(STRICT);

    expect(resolveSessionToolPermission(STRICT, 'bash', { command: 'ls' })).toBe('allow');
    expect(resolveSessionToolPermission(STRICT, 'webfetch', { url: 'https://x' })).toBe('allow');
    expect(resolveSessionToolPermission(STRICT, 'mcp_run', {})).toBe('allow');
    expect(resolveSessionToolPermission(STRICT, 'write', { path: '/tmp/a' })).toBe('ask');
  });

  it('keeps hard deny rules', () => {
    setPermissionRules([{ tool: 'bash', action: 'deny' }]);
    markStrictRemoteSession(STRICT);
    expect(resolveSessionToolPermission(STRICT, 'bash', { command: 'ls' })).toBe('deny');
  });

  it('keeps Always Allow but never workflow auto-approve', () => {
    rememberAlwaysAllow(STRICT, 'write');
    rememberAutoApproveToolPermissions(STRICT);
    markStrictRemoteSession(STRICT);

    expect(sessionAutoApprovesToolPermissions(STRICT)).toBe(false);
    expect(resolveSessionToolPermission(STRICT, 'write', { path: '/tmp/a' })).toBe('allow');
    expect(resolveSessionToolPermission(STRICT, 'edit', { path: '/tmp/a' })).toBe('ask');
  });

  it('can be unmarked', () => {
    markStrictRemoteSession(STRICT);
    expect(isStrictRemoteSession(STRICT)).toBe(true);
    unmarkStrictRemoteSession(STRICT);
    expect(isStrictRemoteSession(STRICT)).toBe(false);
  });
});
