import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHttpRelayRoomsForTests,
  createCollabHttpRelayRouter,
} from '../backend/src/collab/http-relay';
import { CollabWsProvider, type CollabTransport } from '../src/main/collab/collab-ws-provider';

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Express relay whose WebSocket upgrades are answered like the production proxy (JSON 401). */
async function startRelay(): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use('/collab', createCollabHttpRelayRouter());
  const server = createServer(app);
  server.on('upgrade', (_req, socket) => {
    const body = JSON.stringify({ error: 'Authentication required' });
    socket.end(
      `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `127.0.0.1:${port}` };
}

describe('collab HTTP relay', () => {
  const providers: CollabWsProvider[] = [];
  let server: Server | null = null;

  afterEach(async () => {
    for (const provider of providers.splice(0)) provider.destroy();
    clearHttpRelayRoomsForTests();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('falls back from a refused WebSocket and syncs history, live edits and presence', async () => {
    const relay = await startRelay();
    server = relay.server;
    const room = 'room-abc123';
    const transports: Array<{ transport: CollabTransport; reason?: string }> = [];
    const connect = (doc: Y.Doc) => {
      const provider = new CollabWsProvider({
        url: `ws://${relay.base}/collab/ws?roomId=${room}`,
        httpUrl: `http://${relay.base}/collab/rooms/${room}/frames`,
        doc,
        onTransport: (transport, reason) => transports.push({ transport, reason }),
      });
      providers.push(provider);
      return provider;
    };

    const ownerDoc = new Y.Doc();
    ownerDoc.getMap('meta').set('title', 'Team plan');
    ownerDoc.getMap('messages').set('m1', 'history before join');
    const owner = connect(ownerDoc);
    owner.awareness.setLocalStateField('user', { sub: 'owner' });
    await waitFor(() => owner.connected);
    expect(owner.transport).toBe('http');
    expect(transports[0]?.reason).toContain('HTTP 401');

    const memberDoc = new Y.Doc();
    const member = connect(memberDoc);
    member.awareness.setLocalStateField('user', { sub: 'member' });

    await waitFor(() => memberDoc.getMap('messages').get('m1') === 'history before join');
    expect(memberDoc.getMap('meta').get('title')).toBe('Team plan');

    memberDoc.getMap('messages').set('m2', 'live from member');
    await waitFor(() => ownerDoc.getMap('messages').get('m2') === 'live from member');

    ownerDoc.getMap('meta').set('title', 'Renamed');
    await waitFor(() => memberDoc.getMap('meta').get('title') === 'Renamed');

    await waitFor(() => owner.awareness.getStates().size === 2);
    member.destroy();
    await waitFor(() => owner.awareness.getStates().size === 1);
  });

  it('resyncs after the relay loses its rooms', async () => {
    const relay = await startRelay();
    server = relay.server;
    const room = 'room-restart1';
    const connect = (doc: Y.Doc) => {
      const provider = new CollabWsProvider({
        url: `ws://${relay.base}/collab/ws`,
        httpUrl: `http://${relay.base}/collab/rooms/${room}/frames`,
        doc,
        forceHttp: true,
      });
      providers.push(provider);
      return provider;
    };

    const a = new Y.Doc();
    const b = new Y.Doc();
    connect(a);
    connect(b);
    a.getMap('messages').set('x', 1);
    await waitFor(() => b.getMap('messages').get('x') === 1);

    clearHttpRelayRoomsForTests();
    b.getMap('messages').set('y', 2);
    await waitFor(() => a.getMap('messages').get('y') === 2);
  }, 20000);
});
