import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../src/renderer/store';
import type { PermissionRequest } from '../src/renderer/types';

function perm(toolUseId: string, channel: string): PermissionRequest {
  return {
    sessionId: 's1',
    toolUseId,
    toolName: 'post_message',
    input: { channel, text: 'hi' },
  };
}

describe('permission queue', () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingPermission: null,
      permissionQueue: [],
    });
  });

  it('shows the first ask immediately and queues the second', () => {
    const store = useAppStore.getState();
    store.enqueuePermission(perm('a', 'C1'));
    store.enqueuePermission(perm('b', 'C2'));

    const next = useAppStore.getState();
    expect(next.pendingPermission?.toolUseId).toBe('a');
    expect(next.pendingPermission?.input.channel).toBe('C1');
    expect(next.permissionQueue).toHaveLength(1);
    expect(next.permissionQueue[0].toolUseId).toBe('b');
  });

  it('surfaces the next ask after Allow/Deny on the current one', () => {
    const store = useAppStore.getState();
    store.enqueuePermission(perm('a', 'C1'));
    store.enqueuePermission(perm('b', 'C2'));

    store.dequeuePermission('a');

    const next = useAppStore.getState();
    expect(next.pendingPermission?.toolUseId).toBe('b');
    expect(next.pendingPermission?.input.channel).toBe('C2');
    expect(next.permissionQueue).toHaveLength(0);
  });

  it('does not drop a queued ask when dismissing a different toolUseId', () => {
    const store = useAppStore.getState();
    store.enqueuePermission(perm('a', 'C1'));
    store.enqueuePermission(perm('b', 'C2'));

    store.dequeuePermission('missing');

    const next = useAppStore.getState();
    expect(next.pendingPermission?.toolUseId).toBe('a');
    expect(next.permissionQueue.map((p) => p.toolUseId)).toEqual(['b']);
  });
});
