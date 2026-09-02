/**
 * Legacy fetch interceptor — disabled.
 *
 * pi-ai routes York LLM via the OpenAI SDK. Wrapping `response.body` to hold a
 * concurrency slot until the stream ends broke streaming / leaked slots, which
 * made later chats wait minutes for "Connected to York LLM".
 *
 * Concurrency is now gated at the agent-turn / one-shot level instead
 * (see `acquireYorkLlmSlot` in agent-runner + sdk-one-shot).
 */

type FetchFn = typeof fetch;

let installed = false;
let originalFetch: FetchFn | null = null;

export function installYorkLlmFetchGate(_fetchImpl: FetchFn = globalThis.fetch): void {
  // No-op: keep API so startup still calls it safely.
  installed = true;
}

export function uninstallYorkLlmFetchGate(): void {
  if (!installed) return;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  installed = false;
}

export function isYorkLlmFetchGateInstalled(): boolean {
  return installed;
}

/** @internal test helper — passthrough (no acquire) */
export async function yorkLlmGatedFetchForTests(
  fetchFn: FetchFn,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return fetchFn(input, init);
}
