/**
 * HTTP long-poll fallback for the Yjs relay, for proxies that do not forward
 * WebSocket upgrades. Same model as yjs-relay.ts: opaque binary frames, memory only,
 * rooms are dropped once idle. Mount behind requireCognito.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import express from 'express';

const MAX_ROOMS = 500;
const MAX_FRAMES_PER_ROOM = 2000;
const MAX_BYTES_PER_ROOM = 16 * 1024 * 1024;
const MAX_FRAMES_PER_POST = 200;
const MAX_WAIT_MS = 25_000;
const ROOM_IDLE_MS = 30 * 60_000;
const ROOM_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

interface Frame {
  seq: number;
  from: string;
  data: Buffer;
}

interface Room {
  /** Changes whenever the room is recreated, so clients know their cursor is stale. */
  epoch: string;
  frames: Frame[];
  nextSeq: number;
  bytes: number;
  waiters: Set<() => void>;
  lastActive: number;
}

const rooms = new Map<string, Room>();

export function clearHttpRelayRoomsForTests(): void {
  const cleared = [...rooms.values()];
  rooms.clear();
  for (const room of cleared) {
    for (const wake of [...room.waiters]) wake();
  }
}

function sweepIdleRooms(now: number): void {
  for (const [id, room] of rooms) {
    if (room.waiters.size === 0 && now - room.lastActive > ROOM_IDLE_MS) {
      rooms.delete(id);
    }
  }
}

function getRoom(roomId: string, create: boolean): Room | null {
  const existing = rooms.get(roomId);
  if (existing) return existing;
  if (!create) return null;
  const now = Date.now();
  sweepIdleRooms(now);
  if (rooms.size >= MAX_ROOMS) return null;
  const room: Room = {
    epoch: randomUUID(),
    frames: [],
    nextSeq: 1,
    bytes: 0,
    waiters: new Set(),
    lastActive: now,
  };
  rooms.set(roomId, room);
  return room;
}

function appendFrame(room: Room, from: string, data: Buffer): void {
  room.frames.push({ seq: room.nextSeq++, from, data });
  room.bytes += data.byteLength;
  while (
    room.frames.length > MAX_FRAMES_PER_ROOM ||
    (room.bytes > MAX_BYTES_PER_ROOM && room.frames.length > 1)
  ) {
    const dropped = room.frames.shift();
    if (dropped) room.bytes -= dropped.data.byteLength;
  }
}

function readFrames(room: Room, after: number, clientId: string) {
  const oldest = room.frames[0]?.seq ?? room.nextSeq;
  const gap = after > 0 && after + 1 < oldest;
  const frames = room.frames
    .filter((frame) => frame.seq > after && frame.from !== clientId)
    .map((frame) => frame.data.toString('base64'));
  return { epoch: room.epoch, seq: room.nextSeq - 1, gap, frames };
}

function hasFramesFor(room: Room, after: number, clientId: string): boolean {
  for (let i = room.frames.length - 1; i >= 0; i--) {
    const frame = room.frames[i];
    if (frame.seq <= after) return false;
    if (frame.from !== clientId) return true;
  }
  return false;
}

function paramRoomId(req: Request): string | null {
  const roomId = typeof req.params.roomId === 'string' ? req.params.roomId.trim() : '';
  return ROOM_ID_RE.test(roomId) ? roomId : null;
}

export function createCollabHttpRelayRouter(): Router {
  const router = Router();

  router.post(
    '/rooms/:roomId/frames',
    express.json({ limit: '12mb' }),
    (req: Request, res: Response) => {
      const roomId = paramRoomId(req);
      const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
      const frames = Array.isArray(req.body?.frames) ? (req.body.frames as unknown[]) : null;
      if (!roomId || !CLIENT_ID_RE.test(clientId) || !frames) {
        res.status(400).json({ error: 'roomId, clientId and frames are required' });
        return;
      }
      if (frames.length > MAX_FRAMES_PER_POST) {
        res.status(413).json({ error: 'Too many frames' });
        return;
      }
      const room = getRoom(roomId, true);
      if (!room) {
        res.status(503).json({ error: 'Relay is at capacity' });
        return;
      }
      for (const raw of frames) {
        if (typeof raw !== 'string' || !raw) continue;
        appendFrame(room, clientId, Buffer.from(raw, 'base64'));
      }
      room.lastActive = Date.now();
      const waiters = [...room.waiters];
      room.waiters.clear();
      for (const wake of waiters) wake();
      res.json({ seq: room.nextSeq - 1 });
    }
  );

  router.get('/rooms/:roomId/frames', (req: Request, res: Response) => {
    const roomId = paramRoomId(req);
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
    const epoch = typeof req.query.epoch === 'string' ? req.query.epoch : '';
    let after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0);
    const waitMs = Math.min(
      MAX_WAIT_MS,
      Math.max(0, Number.parseInt(String(req.query.waitMs ?? '0'), 10) || 0)
    );
    if (!roomId || !CLIENT_ID_RE.test(clientId)) {
      res.status(400).json({ error: 'roomId and clientId are required' });
      return;
    }
    const room = getRoom(roomId, true);
    if (!room) {
      res.status(503).json({ error: 'Relay is at capacity' });
      return;
    }
    room.lastActive = Date.now();

    // A cursor from another epoch predates a restart: replay everything the room holds.
    if ((epoch && epoch !== room.epoch) || after > room.nextSeq - 1) {
      after = 0;
    }
    if (waitMs === 0 || hasFramesFor(room, after, clientId) || epoch !== room.epoch) {
      res.json(readFrames(room, after, clientId));
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      room.waiters.delete(wake);
      room.lastActive = Date.now();
      if (!res.headersSent) res.json(readFrames(room, after, clientId));
    };
    const wake = () => {
      if (hasFramesFor(room, after, clientId) || !rooms.has(roomId)) {
        finish();
      } else if (!done) {
        room.waiters.add(wake);
      }
    };
    const timer = setTimeout(finish, waitMs);
    room.waiters.add(wake);
    // req 'close' fires as soon as a bodiless GET is consumed; res 'close' means the client left.
    res.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      room.waiters.delete(wake);
    });
  });

  return router;
}
