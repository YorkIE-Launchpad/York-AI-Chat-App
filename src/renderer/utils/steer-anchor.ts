/** Renderer message id waiting for the backend to deliver a send-now follow-up. */
const pendingSteerAnchor: Record<string, string> = {};

/** Latest send-now bubble. A newer click replaces an older one still waiting. */
export function rememberSteerAnchor(sessionId: string, messageId: string): void {
  pendingSteerAnchor[sessionId] = messageId;
}

/** Take the pending send-now id once the follow-up is actually delivered. */
export function consumeSteerAnchor(sessionId: string): string | undefined {
  const messageId = pendingSteerAnchor[sessionId];
  if (!messageId) return undefined;
  delete pendingSteerAnchor[sessionId];
  return messageId;
}

export function clearSteerAnchor(sessionId: string): void {
  delete pendingSteerAnchor[sessionId];
}
