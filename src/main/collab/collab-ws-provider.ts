/**
 * Minimal Yjs sync + awareness over the backend's binary fan-out relay.
 * Tries the WebSocket relay (backend/src/collab/yjs-relay.ts) first and falls back
 * to HTTP long-polling (backend/src/collab/http-relay.ts) when the upgrade is refused,
 * e.g. a reverse proxy that does not forward `Upgrade` headers.
 * Uses the `ws` package API (Node / Electron main).
 */
import { randomUUID } from 'crypto';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import WebSocket from 'ws';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const WS_OPEN_TIMEOUT_MS = 10_000;
const WS_FAILURES_BEFORE_HTTP = 2;
const HTTP_POLL_WAIT_MS = 25_000;
const HTTP_REQUEST_TIMEOUT_MS = 40_000;
const HTTP_RETRY_MS = 2_000;
const HTTP_FLUSH_DELAY_MS = 20;
const HTTP_MAX_FRAMES_PER_POST = 150;

export type CollabWsStatus = 'connecting' | 'connected' | 'disconnected';
export type CollabTransport = 'ws' | 'http';

type FetchLike = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CollabWsProviderOptions {
  url: string;
  doc: Y.Doc;
  awareness?: awarenessProtocol.Awareness;
  onStatus?: (status: CollabWsStatus) => void;
  /** `${backend}/collab/rooms/<roomId>/frames` — enables the long-poll fallback. */
  httpUrl?: string;
  getHttpHeaders?: () => Promise<Record<string, string>>;
  onTransport?: (transport: CollabTransport, reason?: string) => void;
  /** Skip the WebSocket attempt (tests, or after a known-bad proxy). */
  forceHttp?: boolean;
  fetchImpl?: FetchLike;
}

export class CollabWsProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly onStatus?: (status: CollabWsStatus) => void;
  private readonly onTransport?: (transport: CollabTransport, reason?: string) => void;
  private readonly httpUrl?: string;
  private readonly getHttpHeaders?: () => Promise<Record<string, string>>;
  private readonly fetchImpl: FetchLike;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private wsFailures = 0;
  private markSynced: (() => void) | null = null;
  private transportMode: CollabTransport = 'ws';
  private status: CollabWsStatus = 'connecting';

  private readonly clientId = randomUUID();
  private httpOnline = false;
  private httpCursor = 0;
  private httpEpoch = '';
  private httpNeedsResync = false;
  private httpOutbox: Uint8Array[] = [];
  private httpFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private httpFlushing = false;
  private httpAbort: AbortController | null = null;
  private httpRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resolves when a peer sends document state (sync step 2 or an update). */
  readonly whenRemoteUpdate: Promise<void>;

  constructor(options: CollabWsProviderOptions) {
    this.doc = options.doc;
    this.awareness = options.awareness ?? new awarenessProtocol.Awareness(options.doc);
    this.url = options.url;
    this.onStatus = options.onStatus;
    this.onTransport = options.onTransport;
    this.httpUrl = options.httpUrl;
    this.getHttpHeaders = options.getHttpHeaders;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.whenRemoteUpdate = new Promise((resolve) => {
      this.markSynced = resolve;
    });

    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    if (options.forceHttp && this.httpUrl) {
      this.transportMode = 'http';
      this.onTransport?.('http', 'forced');
      this.startHttp();
    } else {
      this.connect();
    }
  }

  get transport(): CollabTransport {
    return this.transportMode;
  }

  private emitStatus(status: CollabWsStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || this.destroyed) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  private handleAwarenessUpdate = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ): void => {
    if (origin === this || this.destroyed) return;
    const changed = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
    );
    this.send(encoding.toUint8Array(encoder));
  };

  private send(data: Uint8Array): void {
    if (this.destroyed) return;
    if (this.transportMode === 'http') {
      if (!this.httpOnline) {
        // Dropped frames are recovered by the full-state push on reconnect.
        this.httpNeedsResync = true;
        return;
      }
      this.httpOutbox.push(data);
      this.scheduleHttpFlush();
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // ---------------------------------------------------------------- WebSocket

  private connect(): void {
    if (this.destroyed || this.transportMode !== 'ws') return;
    this.emitStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;

    this.wsOpenTimer = setTimeout(() => {
      if (!opened && this.ws === ws) {
        this.switchToHttp('WebSocket open timed out');
      }
    }, WS_OPEN_TIMEOUT_MS);

    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      // The relay answers with a bare status; a proxy/app 4xx/5xx means no relay behind this URL.
      this.switchToHttp(`WebSocket upgrade refused (HTTP ${res.statusCode ?? '?'})`);
    });

    ws.on('open', () => {
      opened = true;
      this.wsFailures = 0;
      if (this.wsOpenTimer) clearTimeout(this.wsOpenTimer);
      this.wsOpenTimer = null;
      this.emitStatus('connected');
      this.onTransport?.('ws');
      this.announce();
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data)
        ? new Uint8Array(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data as Uint8Array);
      this.readMessage(buf);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      if (this.wsOpenTimer) clearTimeout(this.wsOpenTimer);
      this.wsOpenTimer = null;
      this.ws = null;
      if (this.destroyed || this.transportMode !== 'ws') return;
      this.emitStatus('disconnected');
      if (!opened) {
        this.wsFailures += 1;
        if (this.wsFailures >= WS_FAILURES_BEFORE_HTTP && this.httpUrl) {
          this.switchToHttp('WebSocket could not connect');
          return;
        }
      }
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    });

    ws.on('error', () => {
      // close follows
    });
  }

  private closeWs(): void {
    if (this.wsOpenTimer) clearTimeout(this.wsOpenTimer);
    this.wsOpenTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeAllListeners('message');
    ws.on('error', () => undefined);
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }

  private switchToHttp(reason: string): void {
    if (this.destroyed || this.transportMode === 'http') return;
    if (!this.httpUrl) {
      this.closeWs();
      this.emitStatus('disconnected');
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
      return;
    }
    this.closeWs();
    this.transportMode = 'http';
    this.onTransport?.('http', reason);
    this.startHttp();
  }

  // ---------------------------------------------------------------- HTTP long-poll

  private async httpHeaders(): Promise<Record<string, string>> {
    const base = this.getHttpHeaders ? await this.getHttpHeaders() : {};
    return { ...base, Accept: 'application/json' };
  }

  private startHttp(): void {
    this.emitStatus('connecting');
    void this.pollLoop();
  }

  private waitRetry(): Promise<void> {
    return new Promise((resolve) => {
      this.httpRetryTimer = setTimeout(() => {
        this.httpRetryTimer = null;
        resolve();
      }, HTTP_RETRY_MS);
    });
  }

  private setHttpOffline(): void {
    if (this.httpOnline) {
      this.httpOnline = false;
      this.httpNeedsResync = true;
    }
    this.httpOutbox = [];
    this.emitStatus('disconnected');
  }

  private async pollLoop(): Promise<void> {
    let first = true;
    while (!this.destroyed && this.transportMode === 'http') {
      const abort = new AbortController();
      this.httpAbort = abort;
      const timeout = setTimeout(() => abort.abort(), HTTP_REQUEST_TIMEOUT_MS);
      try {
        const url = new URL(this.httpUrl as string);
        url.searchParams.set('after', String(this.httpCursor));
        url.searchParams.set('clientId', this.clientId);
        if (this.httpEpoch) url.searchParams.set('epoch', this.httpEpoch);
        url.searchParams.set('waitMs', String(first || !this.httpOnline ? 0 : HTTP_POLL_WAIT_MS));
        const res = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: await this.httpHeaders(),
          signal: abort.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          epoch?: string;
          seq?: number;
          gap?: boolean;
          frames?: unknown;
        };
        if (this.destroyed) return;
        const seq = typeof body.seq === 'number' ? body.seq : this.httpCursor;
        const frames = Array.isArray(body.frames) ? body.frames : [];
        const epoch = typeof body.epoch === 'string' ? body.epoch : '';
        const relayRestarted =
          seq < this.httpCursor || (!!this.httpEpoch && !!epoch && epoch !== this.httpEpoch);
        this.httpCursor = seq;
        if (epoch) this.httpEpoch = epoch;
        for (const raw of frames) {
          if (typeof raw !== 'string' || !raw) continue;
          this.readMessage(new Uint8Array(Buffer.from(raw, 'base64')));
        }
        if (!this.httpOnline) {
          this.httpOnline = true;
          this.httpNeedsResync = false;
          this.emitStatus('connected');
          this.announce();
        } else if (this.httpNeedsResync || body.gap || relayRestarted) {
          this.httpNeedsResync = false;
          this.announce();
        }
        first = false;
      } catch {
        if (this.destroyed) return;
        this.setHttpOffline();
        await this.waitRetry();
      } finally {
        clearTimeout(timeout);
        if (this.httpAbort === abort) this.httpAbort = null;
      }
    }
  }

  private scheduleHttpFlush(): void {
    if (this.httpFlushTimer || this.httpFlushing) return;
    this.httpFlushTimer = setTimeout(() => {
      this.httpFlushTimer = null;
      void this.flushHttp();
    }, HTTP_FLUSH_DELAY_MS);
  }

  private async flushHttp(): Promise<void> {
    if (this.httpFlushing || this.destroyed) return;
    this.httpFlushing = true;
    try {
      while (this.httpOutbox.length > 0 && !this.destroyed && this.httpOnline) {
        const batch = this.httpOutbox.splice(0, HTTP_MAX_FRAMES_PER_POST);
        const res = await this.fetchImpl(this.httpUrl as string, {
          method: 'POST',
          headers: { ...(await this.httpHeaders()), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: this.clientId,
            frames: batch.map((frame) => Buffer.from(frame).toString('base64')),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      if (!this.destroyed) this.setHttpOffline();
    } finally {
      this.httpFlushing = false;
      if (this.httpOutbox.length > 0 && this.httpOnline && !this.destroyed) {
        this.scheduleHttpFlush();
      }
    }
  }

  // ---------------------------------------------------------------- shared

  /** Sync step 1 + awareness + full local state, so peers that missed frames still converge. */
  private announce(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoding.toUint8Array(encoder));

    if (this.awareness.getLocalState() !== null) {
      const awEncoder = encoding.createEncoder();
      encoding.writeVarUint(awEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
      );
      this.send(encoding.toUint8Array(awEncoder));
    }
    this.pushLocalState();
  }

  private noteRemoteSync(buf: Uint8Array): void {
    try {
      const peek = decoding.createDecoder(buf);
      decoding.readVarUint(peek);
      const syncType = decoding.readVarUint(peek);
      // 1 = sync step 2, 2 = incremental update. Step 1 is only a state vector.
      if (syncType === 1 || syncType === 2) {
        this.markSynced?.();
        this.markSynced = null;
      }
    } catch {
      // ignore malformed frames
    }
  }

  private readMessage(buf: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(buf);
      const messageType = decoding.readVarUint(decoder);
      switch (messageType) {
        case MESSAGE_SYNC: {
          this.noteRemoteSync(buf);
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
          if (encoding.length(encoder) > 1) {
            this.send(encoding.toUint8Array(encoder));
          }
          break;
        }
        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            this
          );
          break;
        }
        default:
          break;
      }
    } catch {
      // A malformed frame from one peer must not break the room.
    }
  }

  get connected(): boolean {
    if (this.transportMode === 'http') return this.httpOnline && !this.destroyed;
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Send this doc's full state as a Yjs update so peers merge history. */
  pushLocalState(): void {
    if (!this.connected || this.destroyed) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(this.doc));
    this.send(encoding.toUint8Array(encoder));
  }

  /** Re-announce sync step 1 and push local state so a newly joined peer gets history. */
  requestSync(): void {
    if (!this.connected || this.destroyed) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoding.toUint8Array(encoder));
    this.pushLocalState();
  }

  destroy(): void {
    if (this.destroyed) return;
    // Tell peers we left while the transport is still usable.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    if (this.transportMode === 'http') void this.flushHttp();
    this.destroyed = true;
    this.markSynced?.();
    this.markSynced = null;
    if (this.wsOpenTimer) clearTimeout(this.wsOpenTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.on('error', () => undefined);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (this.httpFlushTimer) clearTimeout(this.httpFlushTimer);
    if (this.httpRetryTimer) clearTimeout(this.httpRetryTimer);
    this.httpAbort?.abort();
    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
  }
}
