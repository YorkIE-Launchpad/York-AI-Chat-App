export const DEFAULT_YORK_LLM_MAX_CONCURRENT = 15;

export function resolveYorkLlmMaxConcurrent(): number {
  const raw = process.env.YORK_LLM_MAX_CONCURRENT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_YORK_LLM_MAX_CONCURRENT;
}

export interface YorkLlmQueueSnapshot {
  maxConcurrent: number;
  activeCount: number;
  waitingCount: number;
}

interface Waiter {
  grant: (release: () => void) => void;
}

export class YorkLlmQueueAbortedError extends Error {
  constructor() {
    super('York LLM queue wait aborted');
    this.name = 'YorkLlmQueueAbortedError';
  }
}

/** Global FIFO semaphore: the shared llama.cpp server only has a fixed number of slots. */
export class YorkLlmQueue {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly maxConcurrent: () => number = resolveYorkLlmMaxConcurrent) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new YorkLlmQueueAbortedError());
    }
    if (this.active < this.maxConcurrent() && this.waiting.length === 0) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: (release) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new YorkLlmQueueAbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  snapshot(): YorkLlmQueueSnapshot {
    return {
      maxConcurrent: this.maxConcurrent(),
      activeCount: this.active,
      waitingCount: this.waiting.length,
    };
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.promote();
    };
  }

  private promote(): void {
    while (this.active < this.maxConcurrent() && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.active += 1;
      next.grant(this.createRelease());
    }
  }
}
