import { useEffect, useLayoutEffect, useRef } from 'react';
import { useAppStore } from '../../store';
import { isScrollNearBottom, resolveSessionScrollTop } from '../../utils/chat-scroll-position';

/**
 * Restores each chat's scroll position and follows new content while the user is at the
 * bottom; reading older messages pauses the follow.
 */
export function useChatAutoScroll(
  activeSessionId: string | null,
  messageCount: number,
  partialContentLength: number
) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isUserAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const prevPartialLengthRef = useRef(0);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRequestRef = useRef<number | null>(null);
  const scrollStateRequestRef = useRef<number | null>(null);
  const pendingScrollStateRef = useRef<{ sessionId: string; scrollTop: number } | null>(null);
  const isScrollingRef = useRef(false);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !activeSessionId) return;

    const savedScrollTop = useAppStore.getState().sessionScrollPositions[activeSessionId];
    const restoredScrollTop = resolveSessionScrollTop(
      savedScrollTop,
      container.scrollHeight,
      container.clientHeight
    );
    container.scrollTop = restoredScrollTop;
    isUserAtBottomRef.current = isScrollNearBottom(
      restoredScrollTop,
      container.scrollHeight,
      container.clientHeight
    );

    // Prevent the generic new-message effect from overriding the session restore.
    const sessionState = useAppStore.getState().sessionStates[activeSessionId];
    prevMessageCountRef.current = sessionState?.messages.length ?? 0;
    prevPartialLengthRef.current =
      (sessionState?.partialMessage.length ?? 0) + (sessionState?.partialThinking.length ?? 0);
  }, [activeSessionId]);

  // Debounced scroll function to prevent scroll conflicts
  const scrollToBottom = useRef((behavior: ScrollBehavior = 'auto', immediate: boolean = false) => {
    // Cancel any pending scroll requests
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (scrollRequestRef.current) {
      cancelAnimationFrame(scrollRequestRef.current);
      scrollRequestRef.current = null;
    }

    const performScroll = () => {
      if (!isUserAtBottomRef.current) return;

      // Mark as scrolling to prevent concurrent scrolls
      isScrollingRef.current = true;

      messagesEndRef.current?.scrollIntoView({ behavior });

      // Reset scrolling flag after a short delay
      setTimeout(
        () => {
          isScrollingRef.current = false;
        },
        behavior === 'smooth' ? 300 : 50
      );
    };

    if (immediate) {
      performScroll();
    } else {
      // Use RAF + timeout for debouncing
      scrollRequestRef.current = requestAnimationFrame(() => {
        scrollTimeoutRef.current = setTimeout(performScroll, 16); // ~1 frame delay
      });
    }
  }).current;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const flushScrollPosition = () => {
      scrollStateRequestRef.current = null;
      const pending = pendingScrollStateRef.current;
      pendingScrollStateRef.current = null;
      if (pending) {
        useAppStore.getState().setSessionScrollPosition(pending.sessionId, pending.scrollTop);
      }
    };

    const updateScrollState = () => {
      const distanceToBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isUserAtBottomRef.current = distanceToBottom <= 80;
      if (activeSessionId) {
        pendingScrollStateRef.current = {
          sessionId: activeSessionId,
          scrollTop: container.scrollTop,
        };
        if (scrollStateRequestRef.current === null) {
          scrollStateRequestRef.current = requestAnimationFrame(flushScrollPosition);
        }
      }
    };
    updateScrollState();
    // Keep new messages from interrupting the user while they read older content.
    const onScroll = () => updateScrollState();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (scrollStateRequestRef.current !== null) {
        cancelAnimationFrame(scrollStateRequestRef.current);
      }
      flushScrollPosition();
    };
  }, [activeSessionId]);

  useEffect(() => {
    const partialLength = partialContentLength;
    const hasNewMessage = messageCount !== prevMessageCountRef.current;
    const isStreamingTick = partialLength !== prevPartialLengthRef.current && !hasNewMessage;

    // Skip scroll if already scrolling (prevent conflicts)
    if (isScrollingRef.current) {
      prevMessageCountRef.current = messageCount;
      prevPartialLengthRef.current = partialLength;
      return;
    }

    if (isUserAtBottomRef.current) {
      if (!isStreamingTick) {
        // New message - use smooth scroll but with debounce
        const behavior: ScrollBehavior = hasNewMessage ? 'smooth' : 'auto';
        scrollToBottom(behavior, false);
      } else {
        // Streaming tick - use instant scroll with debounce
        scrollToBottom('auto', false);
      }
    }

    prevMessageCountRef.current = messageCount;
    prevPartialLengthRef.current = partialLength;
  }, [messageCount, partialContentLength, scrollToBottom]);

  // Additional scroll trigger for content height changes (e.g., TodoWrite expand/collapse)
  useEffect(() => {
    const container = scrollContainerRef.current;
    const messagesContainer = messagesContainerRef.current;
    if (!container || !messagesContainer) return;

    const resizeObserver = new ResizeObserver(() => {
      // Don't interfere with ongoing scrolls
      if (!isScrollingRef.current && isUserAtBottomRef.current) {
        // Scroll to bottom when content height changes
        scrollToBottom('auto', false);
      }
    });

    resizeObserver.observe(messagesContainer);

    return () => {
      resizeObserver.disconnect();
    };
  }, [scrollToBottom]); // scrollToBottom is stable (useRef); ResizeObserver only needs that binding

  // Cleanup scroll timeouts on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (scrollRequestRef.current) {
        cancelAnimationFrame(scrollRequestRef.current);
      }
    };
  }, []);

  return { messagesEndRef, scrollContainerRef, messagesContainerRef, isUserAtBottomRef };
}
