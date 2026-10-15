import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { RemoteGateway } from '../src/main/remote/gateway';
import type { GatewayAuthConfig } from '../src/main/remote/types';

const routeMessage = vi.fn(async () => {});
const messageRouter = {
  onResponse: vi.fn(),
  routeMessage,
  getActiveSessionCount: vi.fn(() => 0),
};

let gateway: RemoteGateway | undefined;

async function startGateway(auth: GatewayAuthConfig): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gateway = new RemoteGateway(
    { enabled: true, port: 0, bind: '127.0.0.1', auth },
    messageRouter as any
  );
  await gateway.start();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((gateway as any).httpServer.address() as AddressInfo).port;
}

function connect(
  port: number,
  headers: Record<string, string> = {}
): Promise<{ ws: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode }));
    ws.once('error', () => resolve({ ws }));
  });
}

function sendAndReceive(ws: WebSocket, msg: object, type: string): Promise<{ payload: unknown }> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === type) {
        ws.off('message', onMessage);
        resolve(parsed);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
}

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  routeMessage.mockClear();
});

describe('RemoteGateway /ws authentication', () => {
  it.each(['allowlist', 'pairing', 'open'] as const)(
    'refuses the WebSocket upgrade in %s mode',
    async (mode) => {
      const port = await startGateway({ mode, allowlist: ['someone'] });
      const { status } = await connect(port);
      expect(status).toBe(403);
    }
  );

  it('refuses the upgrade in token mode without a configured token', async () => {
    const port = await startGateway({ mode: 'token' });
    const { status } = await connect(port);
    expect(status).toBe(403);
  });

  it('refuses upgrades that carry a browser Origin header', async () => {
    const port = await startGateway({ mode: 'token', token: 'secret' });
    const { status } = await connect(port, { Origin: 'https://evil.example' });
    expect(status).toBe(403);
  });

  it('rejects a wrong or missing token and blocks messages', async () => {
    const port = await startGateway({ mode: 'token', token: 'secret' });
    const { ws } = await connect(port);

    const missing = await sendAndReceive(ws, { type: 'auth', payload: {} }, 'auth_result');
    expect(missing.payload).toMatchObject({ success: false });

    const wrong = await sendAndReceive(
      ws,
      { type: 'auth', payload: { token: 'nope' } },
      'auth_result'
    );
    expect(wrong.payload).toMatchObject({ success: false });

    const err = await sendAndReceive(ws, { type: 'message', payload: { text: 'hi' } }, 'error');
    expect(err.payload).toMatchObject({ error: 'Not authenticated' });
    expect(routeMessage).not.toHaveBeenCalled();
    ws.close();
  });

  it('authenticates with the correct token and routes messages', async () => {
    const port = await startGateway({ mode: 'token', token: 'secret' });
    const { ws } = await connect(port);

    const ok = await sendAndReceive(
      ws,
      { type: 'auth', payload: { token: 'secret' } },
      'auth_result'
    );
    expect(ok.payload).toMatchObject({ success: true });

    ws.send(JSON.stringify({ type: 'message', payload: { text: 'hi' } }));
    await vi.waitFor(() => expect(routeMessage).toHaveBeenCalledTimes(1));
    ws.close();
  });
});
