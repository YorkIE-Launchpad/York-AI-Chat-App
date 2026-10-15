import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { RemoteGateway } from '../src/main/remote/gateway';
import type { RemoteMessage } from '../src/main/remote/types';

function message(senderId: string, channelType: 'slack' | 'feishu' = 'slack'): RemoteMessage {
  return {
    id: 'm1',
    channelType,
    channelId: 'c1',
    sender: { id: senderId, isBot: false },
    content: { type: 'text', text: 'hi' },
    timestamp: Date.now(),
    isGroup: false,
    isMentioned: true,
  };
}

function createGateway(): RemoteGateway {
  const router = { onResponse: vi.fn(), routeMessage: vi.fn(), getActiveSessionCount: () => 0 };
  return new RemoteGateway(
    { enabled: true, port: 0, bind: '127.0.0.1', auth: { mode: 'allowlist', allowlist: [] } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router as any
  );
}

describe('RemoteGateway owner identities', () => {
  it('authorizes the owner without pairing and rejects everyone else', async () => {
    const gateway = createGateway();
    gateway.addOwnerIdentity('slack', 'U0OWNER');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const check = (m: RemoteMessage) => (gateway as any).checkAuthorization(m);

    await expect(check(message('U0OWNER'))).resolves.toBe(true);
    await expect(check(message('U0OTHER'))).resolves.toBe(false);
    await expect(check(message('U0OWNER', 'feishu'))).resolves.toBe(false);
  });

  it('clears owner identities per channel type', async () => {
    const gateway = createGateway();
    gateway.addOwnerIdentity('slack', 'U0OWNER');
    gateway.clearOwnerIdentities('slack');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).checkAuthorization(message('U0OWNER'))).resolves.toBe(false);
  });
});
