/**
 * Ephemeral Yjs binary fan-out relay. No server-side Y.Doc or room persistence.
 * When the last socket leaves a room, that room is deleted from memory.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyCognitoTokenDetailed } from '../cognito-auth.js';
import { log } from '../safe-log.js';

const MAX_ROOMS = 500;
const MAX_SOCKETS_PER_ROOM = 32;
const MAX_TOTAL_SOCKETS = 2000;

export interface CollabRelaySocketMeta {
  roomId: string;
  userSub: string;
  isOwnerBootstrap: boolean;
}

type LiveSocket = WebSocket & { __collab?: CollabRelaySocketMeta };

/** Exposed for tests — live socket sets only. */
const rooms = new Map<string, Set<LiveSocket>>();

export function getCollabRoomCountForTests(): number {
  return rooms.size;
}

export function getCollabRoomSocketCountForTests(roomId: string): number {
  return rooms.get(roomId)?.size ?? 0;
}

export function clearCollabRoomsForTests(): void {
  for (const set of rooms.values()) {
    for (const ws of set) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
  rooms.clear();
}

function totalSocketCount(): number {
  let n = 0;
  for (const set of rooms.values()) n += set.size;
  return n;
}

function parseQuery(url: string | undefined): URLSearchParams {
  try {
    const u = new URL(url || '', 'http://localhost');
    return u.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function extractToken(req: IncomingMessage, params: URLSearchParams): string | null {
  const q = params.get('token')?.trim();
  if (q) return q;
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(auth);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function cognitoSub(payload: Record<string, unknown>): string | null {
  const sub = payload.sub;
  return typeof sub === 'string' && sub.trim() ? sub.trim() : null;
}

function removeSocket(ws: LiveSocket): void {
  const meta = ws.__collab;
  if (!meta) return;
  const set = rooms.get(meta.roomId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    rooms.delete(meta.roomId);
  }
}

function broadcast(roomId: string, sender: LiveSocket, data: Buffer | ArrayBuffer | Buffer[]): void {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const peer of set) {
    if (peer === sender) continue;
    if (peer.readyState !== peer.OPEN) continue;
    try {
      peer.send(data);
    } catch {
      /* ignore broken peer */
    }
  }
}

export interface AttachCollabRelayOptions {
  path?: string;
}

/**
 * Attach `/collab/ws` upgrade handler to an HTTP server.
 * Query: roomId (required), token (Cognito JWT), invite (required unless owner=1), owner=1 for creator bootstrap.
 */
export function attachCollabRelay(
  server: HttpServer,
  options?: AttachCollabRelayOptions
): WebSocketServer {
  const path = options?.path || '/collab/ws';
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const params = parseQuery(req.url);
    let pathname = '';
    try {
      pathname = new URL(req.url || '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== path) {
      return;
    }

    void (async () => {
      const roomId = params.get('roomId')?.trim() || '';
      if (!roomId || roomId.length > 128) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const token = extractToken(req, params);
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const auth = await verifyCognitoTokenDetailed(token);
      if (!auth.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const userSub = cognitoSub(auth.payload);
      if (!userSub) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const isOwnerBootstrap = params.get('owner') === '1' || params.get('owner') === 'true';
      // Capability model: Cognito + roomId is enough. No server-stored invites.

      if (totalSocketCount() >= MAX_TOTAL_SOCKETS) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      let set = rooms.get(roomId);
      if (!set) {
        if (rooms.size >= MAX_ROOMS) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        set = new Set();
        rooms.set(roomId, set);
      }
      if (set.size >= MAX_SOCKETS_PER_ROOM) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const live = ws as LiveSocket;
        live.__collab = { roomId, userSub, isOwnerBootstrap };
        set!.add(live);
        log(`[collab] join room=${roomId} sub=${userSub.slice(0, 8)}… peers=${set!.size}`);

        live.on('message', (data, isBinary) => {
          if (!isBinary && typeof data === 'string') {
            // Ignore text control frames; Yjs sync is binary.
            return;
          }
          const buf = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
          broadcast(roomId, live, buf);
        });

        live.on('close', () => {
          removeSocket(live);
          log(`[collab] leave room=${roomId} remaining=${rooms.get(roomId)?.size ?? 0}`);
        });

        live.on('error', () => {
          removeSocket(live);
        });
      });
    })().catch(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  return wss;
}
