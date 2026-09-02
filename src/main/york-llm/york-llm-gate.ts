import { randomUUID } from 'node:crypto';
import {
  resolveYorkLlmMaxConcurrent,
  type YorkLlmGateSnapshot,
  type YorkLlmQueueEventPayload,
} from '../../shared/york-llm-config';

export type YorkLlmQueueListener = (event: YorkLlmQueueEventPayload) => void;

interface WaitingTicket {
  ticketId: string;
  sessionId?: string;
  label?: string;
  enqueuedAt: number;
  signal?: AbortSignal;
  resolve: (value: { release: () => void; position: number; ticketId: string }) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
  released: boolean;
}

interface ActiveTicket {
  ticketId: string;
  sessionId?: string;
  label?: string;
  enqueuedAt: number;
  activatedAt: number;
}

export type { YorkLlmGateSnapshot };

class YorkLlmConcurrencyGate {
  private active: ActiveTicket[] = [];
  private waiting: WaitingTicket[] = [];
  private listeners = new Set<YorkLlmQueueListener>();

  private get maxConcurrent(): number {
    return resolveYorkLlmMaxConcurrent();
  }

  subscribe(listener: YorkLlmQueueListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): YorkLlmGateSnapshot {
    const activeTickets = this.active.map((ticket, index) => ({
      ticketId: ticket.ticketId,
      sessionId: ticket.sessionId,
      position: index,
      status: 'active' as const,
    }));
    const waitingTickets = this.waiting.map((ticket, index) => ({
      ticketId: ticket.ticketId,
      sessionId: ticket.sessionId,
      position: index + 1,
      status: 'waiting' as const,
    }));
    return {
      maxConcurrent: this.maxConcurrent,
      activeCount: this.active.length,
      waitingCount: this.waiting.length,
      tickets: [...activeTickets, ...waitingTickets],
    };
  }

  async acquire(input: {
    sessionId?: string;
    label?: string;
    signal?: AbortSignal;
  }): Promise<{ release: () => void; position: number; ticketId: string }> {
    if (input.signal?.aborted) {
      throw new DOMException('York LLM queue aborted', 'AbortError');
    }

    const ticketId = randomUUID();
    if (this.active.length < this.maxConcurrent) {
      return this.activateImmediately(ticketId, input);
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.removeWaitingTicket(ticketId);
        reject(new DOMException('York LLM queue aborted', 'AbortError'));
      };

      const ticket: WaitingTicket = {
        ticketId,
        sessionId: input.sessionId,
        label: input.label,
        enqueuedAt: Date.now(),
        signal: input.signal,
        resolve,
        reject,
        onAbort,
        released: false,
      };

      if (input.signal) {
        input.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiting.push(ticket);
      this.emitForTicket(ticket, 'waiting', this.waiting.indexOf(ticket) + 1);
      this.emitWaitingPositions();
    });
  }

  private activateImmediately(
    ticketId: string,
    input: { sessionId?: string; label?: string; signal?: AbortSignal }
  ): { release: () => void; position: number; ticketId: string } {
    let released = false;
    const activeTicket: ActiveTicket = {
      ticketId,
      sessionId: input.sessionId,
      label: input.label,
      enqueuedAt: Date.now(),
      activatedAt: Date.now(),
    };
    this.active.push(activeTicket);
    this.emitForActive(activeTicket, 'active', 0);

    const release = () => {
      if (released) return;
      released = true;
      this.active = this.active.filter((entry) => entry.ticketId !== ticketId);
      this.emitDone(activeTicket);
      this.promoteNext();
    };

    if (input.signal) {
      input.signal.addEventListener(
        'abort',
        () => {
          release();
        },
        { once: true }
      );
    }

    return { release, position: 0, ticketId };
  }

  private promoteNext(): void {
    while (this.active.length < this.maxConcurrent && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) break;
      if (next.signal?.aborted) {
        next.reject(new DOMException('York LLM queue aborted', 'AbortError'));
        continue;
      }
      if (next.released) {
        continue;
      }

      const { release, ticketId } = this.activateImmediately(next.ticketId, {
        sessionId: next.sessionId,
        label: next.label,
        signal: next.signal,
      });
      next.resolve({ release, position: 0, ticketId });
    }
    this.emitWaitingPositions();
  }

  private removeWaitingTicket(ticketId: string): void {
    const index = this.waiting.findIndex((ticket) => ticket.ticketId === ticketId);
    if (index < 0) return;
    const [removed] = this.waiting.splice(index, 1);
    if (removed.signal) {
      removed.signal.removeEventListener('abort', removed.onAbort);
    }
    this.emitDone({
      ticketId: removed.ticketId,
      sessionId: removed.sessionId,
      label: removed.label,
      enqueuedAt: removed.enqueuedAt,
      activatedAt: removed.enqueuedAt,
    });
    this.emitWaitingPositions();
  }

  private emitWaitingPositions(): void {
    for (let index = 0; index < this.waiting.length; index += 1) {
      const ticket = this.waiting[index];
      this.emitForTicket(ticket, 'waiting', index + 1);
    }
  }

  private emitForTicket(ticket: WaitingTicket, status: 'waiting', position: number): void {
    this.emit({
      sessionId: ticket.sessionId,
      ticketId: ticket.ticketId,
      status,
      position,
      activeCount: this.active.length,
      maxConcurrent: this.maxConcurrent,
      waitingCount: this.waiting.length,
    });
  }

  private emitForActive(ticket: ActiveTicket, status: 'active', position: number): void {
    this.emit({
      sessionId: ticket.sessionId,
      ticketId: ticket.ticketId,
      status,
      position,
      activeCount: this.active.length,
      maxConcurrent: this.maxConcurrent,
      waitingCount: this.waiting.length,
    });
  }

  private emitDone(ticket: ActiveTicket): void {
    this.emit({
      sessionId: ticket.sessionId,
      ticketId: ticket.ticketId,
      status: 'done',
      position: 0,
      activeCount: this.active.length,
      maxConcurrent: this.maxConcurrent,
      waitingCount: this.waiting.length,
    });
  }

  private emit(event: YorkLlmQueueEventPayload): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener failures.
      }
    }
  }

  resetForTests(): void {
    for (const ticket of [...this.waiting]) {
      ticket.signal?.removeEventListener('abort', ticket.onAbort);
      ticket.reject(new Error('York LLM gate reset'));
    }
    this.waiting = [];
    this.active = [];
  }
}

const gate = new YorkLlmConcurrencyGate();

export function subscribeYorkLlmQueue(listener: YorkLlmQueueListener): () => void {
  return gate.subscribe(listener);
}

export function acquireYorkLlmSlot(input: {
  sessionId?: string;
  label?: string;
  signal?: AbortSignal;
}): Promise<{ release: () => void; position: number; ticketId: string }> {
  return gate.acquire(input);
}

export function getYorkLlmGateSnapshot(): YorkLlmGateSnapshot {
  return gate.getSnapshot();
}

/** Test-only: clear queue state between tests. */
export function resetYorkLlmGateForTests(): void {
  gate.resetForTests();
}
