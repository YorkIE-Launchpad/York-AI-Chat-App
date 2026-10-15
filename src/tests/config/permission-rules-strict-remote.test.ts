import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetSessionPermissions,
  isStrictRemoteSession,
  markStrictRemoteSession,
  rememberAlwaysAllow,
  rememberAutoApproveToolPermissions,
  resolveSessionToolPermission,
  resolveSessionToolPermissionAsync,
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
  it('asks for tools that desktop rules or built-ins would auto-allow', async () => {
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    markStrictRemoteSession(STRICT);

    expect(resolveSessionToolPermission(STRICT, 'bash', { command: 'ls' })).toBe('ask');
    expect(resolveSessionToolPermission(STRICT, 'read', { path: '/tmp/a' })).toBe('ask');
    expect(resolveSessionToolPermission(STRICT, 'webfetch', { url: 'https://x' })).toBe('ask');
    expect(await resolveSessionToolPermissionAsync(STRICT, 'bash', { command: 'ls' })).toBe('ask');
  });

  it('keeps hard deny rules', () => {
    setPermissionRules([{ tool: 'bash', action: 'deny' }]);
    markStrictRemoteSession(STRICT);
    expect(resolveSessionToolPermission(STRICT, 'bash', { command: 'ls' })).toBe('deny');
  });

  it('denies tools that would bypass per-call approval', () => {
    markStrictRemoteSession(STRICT);
    expect(resolveSessionToolPermission(STRICT, 'spawn_subagent', {})).toBe('deny');
    expect(resolveSessionToolPermission(STRICT, 'mcp_run', {})).toBe('deny');
  });

  it('never remembers always-allow and clears prior session approvals', () => {
    rememberAlwaysAllow(STRICT, 'bash');
    rememberAutoApproveToolPermissions(STRICT);
    markStrictRemoteSession(STRICT);

    expect(sessionAutoApprovesToolPermissions(STRICT)).toBe(false);
    expect(resolveSessionToolPermission(STRICT, 'bash', { command: 'ls' })).toBe('ask');

    rememberAlwaysAllow(STRICT, 'bash');
    expect(resolveSessionToolPermission(STRICT, 'bash', { command: 'ls' })).toBe('ask');
  });

  it('can be unmarked', () => {
    markStrictRemoteSession(STRICT);
    expect(isStrictRemoteSession(STRICT)).toBe(true);
    unmarkStrictRemoteSession(STRICT);
    expect(isStrictRemoteSession(STRICT)).toBe(false);
  });
});
