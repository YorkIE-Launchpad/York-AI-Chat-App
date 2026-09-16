let chatViewPrefetch: Promise<unknown> | null = null;
let contextPanelPrefetch: Promise<unknown> | null = null;

/** Warm the lazy chunks used when opening a chat from the welcome screen. */
export function prefetchChatPanels(): void {
  if (!chatViewPrefetch) {
    chatViewPrefetch = import('../components/ChatView');
  }
  if (!contextPanelPrefetch) {
    contextPanelPrefetch = import('../components/ContextPanel');
  }
}
