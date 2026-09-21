/**
 * Minimal Yjs sync + awareness over a binary WebSocket fan-out relay.
 * Compatible with backend/src/collab/yjs-relay.ts (no server-side Y.Doc).
 * Uses the `ws` package API (Node / Electron main).
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import WebSocket from 'ws';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type CollabWsStatus = 'connecting' | 'connected' | 'disconnected';

export interface CollabWsProviderOptions {
  url: string;
  doc: Y.Doc;
  awareness?: awarenessProtocol.Awareness;
  onStatus?: (status: CollabWsStatus) => void;
}

export class CollabWsProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly onStatus?: (status: CollabWsStatus) => void;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private markSynced: (() => void) | null = null;
  /** Resolves when a peer sends document state (sync step 2 or an update). */
  readonly whenRemoteUpdate: Promise<void>;

  constructor(options: CollabWsProviderOptions) {
    this.doc = options.doc;
    this.awareness = options.awareness ?? new awarenessProtocol.Awareness(options.doc);
    this.url = options.url;
    this.onStatus = options.onStatus;
    this.whenRemoteUpdate = new Promise((resolve) => {
      this.markSynced = resolve;
    });

    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    this.connect();
  }

  private emitStatus(status: CollabWsStatus): void {
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
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private connect(): void {
    if (this.destroyed) return;
    this.emitStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.emitStatus('connected');
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
      // Stateless relay drops anything sent before the peer joined.
      // Push the whole doc so history arrives even if their sync step 1 was missed.
      this.pushLocalState();
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
      this.emitStatus('disconnected');
      this.ws = null;
      if (this.shouldReconnect && !this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 1500);
      }
    });

    ws.on('error', () => {
      // close follows
    });
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
  }

  get connected(): boolean {
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
    this.destroyed = true;
    this.shouldReconnect = false;
    this.markSynced?.();
    this.markSynced = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
