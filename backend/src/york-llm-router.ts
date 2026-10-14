import express, { type Request, type Response } from 'express';
import { proxyToProvider, type ProviderTarget } from './proxy.js';
import { logError } from './safe-log.js';
import { YorkLlmQueue, YorkLlmQueueAbortedError } from './york-llm-queue.js';

export const DEFAULT_YORK_LLM_UPSTREAM_ORIGIN = 'http://llm.yorkdevs.link:2222';

export function resolveYorkLlmUpstreamOrigin(): string {
  const fromEnv = process.env.YORK_LLM_UPSTREAM_URL?.trim().replace(/\/+$/, '');
  return fromEnv || DEFAULT_YORK_LLM_UPSTREAM_ORIGIN;
}

/**
 * York LLM proxy. Generation calls (POST) wait for a global slot so every client
 * together stays within the llama.cpp server's parallel capacity.
 */
export function createYorkLlmRouter(
  target: ProviderTarget,
  queue: YorkLlmQueue = new YorkLlmQueue()
): express.Router {
  const router = express.Router();

  router.get('/_queue', (_req, res) => {
    res.json(queue.snapshot());
  });

  // Buffer the body before queueing so a long wait cannot trip the server's requestTimeout.
  router.post('*', express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
    void proxyWithSlot(req, res, target, queue);
  });

  router.use((req, res) => {
    void proxyToProvider(req, res, target).catch((err) => {
      logError('[york-llm] proxy error:', err);
    });
  });

  return router;
}

async function proxyWithSlot(
  req: Request,
  res: Response,
  target: ProviderTarget,
  queue: YorkLlmQueue
): Promise<void> {
  const clientGone = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) clientGone.abort();
  };
  res.on('close', onClose);

  let release: (() => void) | undefined;
  try {
    release = await queue.acquire(clientGone.signal);
  } catch (err) {
    res.off('close', onClose);
    if (!(err instanceof YorkLlmQueueAbortedError)) logError('[york-llm] queue error:', err);
    if (!res.headersSent && !res.writableEnded) res.status(499).end();
    return;
  }

  try {
    await proxyToProvider(req, res, target);
  } catch (err) {
    logError('[york-llm] proxy error:', err);
  } finally {
    res.off('close', onClose);
    release();
  }
}
