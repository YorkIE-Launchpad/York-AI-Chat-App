import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import type { ContentBlock, Message } from '../types';

interface MessagePointersProps {
  messages: Message[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onNavigate?: () => void;
}

/** Reserved left gutter so ticks never crowd the chat column. */
export const MESSAGE_POINTERS_GUTTER_CLASS = 'pl-16 pr-5 lg:pl-20 lg:pr-8';

const BASE_TICK_WIDTH = 8;
const MAX_TICK_WIDTH = 22;
const BASE_TICK_HEIGHT = 2;
const MAX_TICK_HEIGHT = 3;
/** Minimum vertical space per tick so every user message stays distinct. */
const MIN_SLOT_PX = 8;
/**
 * Magnification influence in slot units (not raw pixels).
 * ~2 means only the hovered tick + immediate neighbors form the hill.
 */
const MAGNIFY_SLOTS = 2;
/** Fixed inset from the chat pane's left edge (further left than the content column). */
const RAIL_LEFT_PX = 8;

function previewText(message: Message): string {
  const blocks = Array.isArray(message.content)
    ? (message.content as ContentBlock[])
    : [{ type: 'text' as const, text: String(message.content ?? '') }];

  const text = blocks
    .filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string'
    )
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join(' ');

  if (text) return text;

  const hasTranscript = blocks.some((b) => b.type === 'meeting_transcript');
  if (hasTranscript) return 'Meeting transcript';

  const attachmentCount = blocks.filter(
    (b) =>
      b.type === 'image' ||
      b.type === 'file_attachment' ||
      b.type === 'meeting_attachment' ||
      b.type === 'external_reference'
  ).length;
  if (attachmentCount > 0) {
    return attachmentCount === 1 ? 'Attachment' : `${attachmentCount} attachments`;
  }
  return '';
}

function truncatePreview(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function findMessageElement(
  container: HTMLElement,
  messageId: string
): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
}

/** Cosine falloff over slot distance — macOS dock hill curve. */
function dockFactor(distanceSlots: number): number {
  if (distanceSlots >= MAGNIFY_SLOTS) return 0;
  const t = distanceSlots / MAGNIFY_SLOTS;
  return Math.cos((t * Math.PI) / 2);
}

function lerp(min: number, max: number, factor: number): number {
  return min + (max - min) * factor;
}

export function MessagePointers({
  messages,
  scrollContainerRef,
  onNavigate,
}: MessagePointersProps) {
  const userMessages = useMemo(
    () => messages.filter((message) => message.role === 'user'),
    [messages]
  );

  const railRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [magnifyY, setMagnifyY] = useState<number | null>(null);

  const assistantPreviewByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (message.role !== 'user') continue;
      const nextAssistant = messages
        .slice(i + 1)
        .find((item) => item.role === 'assistant' || item.role === 'user');
      if (nextAssistant?.role === 'assistant') {
        map.set(message.id, truncatePreview(previewText(nextAssistant)));
      }
    }
    return map;
  }, [messages]);

  const updateActiveTick = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || userMessages.length < 2) {
      setActiveId(null);
      return;
    }

    const targetY = container.getBoundingClientRect().top + container.clientHeight * 0.25;
    let bestId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const message of userMessages) {
      const element = findMessageElement(container, message.id);
      if (!element) continue;
      const distance = Math.abs(element.getBoundingClientRect().top - targetY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = message.id;
      }
    }

    setActiveId(bestId);
  }, [scrollContainerRef, userMessages]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || userMessages.length < 2) {
      setActiveId(null);
      return;
    }

    updateActiveTick();

    const onScroll = () => {
      updateActiveTick();
    };

    container.addEventListener('scroll', onScroll, { passive: true });

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            updateActiveTick();
          })
        : null;
    resizeObserver?.observe(container);

    return () => {
      container.removeEventListener('scroll', onScroll);
      resizeObserver?.disconnect();
    };
  }, [scrollContainerRef, updateActiveTick, userMessages.length]);

  const handleNavigate = useCallback(
    (messageId: string) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const element = findMessageElement(container, messageId);
      if (!element) return;
      onNavigate?.();
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(messageId);
      setHoveredId(null);
      setMagnifyY(null);
    },
    [onNavigate, scrollContainerRef]
  );

  const handleRailMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    setMagnifyY(event.clientY - rect.top);
  }, []);

  const clearMagnify = useCallback(() => {
    setMagnifyY(null);
    setHoveredId(null);
  }, []);

  if (userMessages.length < 2) return null;

  const count = userMessages.length;
  // Exactly one tick per user message; rail grows so every tick stays visible.
  const railHeight = Math.max(MIN_SLOT_PX * 2, count * MIN_SLOT_PX);
  const slotPx = railHeight / count;

  const hoveredMessage = hoveredId
    ? userMessages.find((message) => message.id === hoveredId)
    : null;
  const hoveredIndex = hoveredMessage
    ? userMessages.findIndex((message) => message.id === hoveredMessage.id)
    : -1;

  return (
    <nav
      className="pointer-events-none absolute inset-y-0 z-20 flex items-center"
      style={{ left: RAIL_LEFT_PX }}
      aria-label="Message navigation"
    >
      <div
        ref={railRef}
        className="pointer-events-auto relative flex w-8 flex-col items-center justify-center"
        style={{ height: railHeight }}
        onMouseMove={handleRailMouseMove}
        onMouseLeave={clearMagnify}
      >
        {userMessages.map((message, index) => {
          const restCenter = (index + 0.5) * slotPx;
          // Continuous float index under the cursor → distance in slots.
          const cursorIndex = magnifyY == null ? null : magnifyY / slotPx - 0.5;
          const distanceSlots =
            cursorIndex == null ? Number.POSITIVE_INFINITY : Math.abs(index - cursorIndex);
          const factor = cursorIndex == null ? 0 : dockFactor(distanceSlots);
          const isActive = message.id === activeId;
          const isHovered = message.id === hoveredId;
          const width = lerp(BASE_TICK_WIDTH, MAX_TICK_WIDTH, factor);
          const height = lerp(BASE_TICK_HEIGHT, MAX_TICK_HEIGHT, factor);
          // Subtle dock-style spread for neighbors only.
          const push =
            cursorIndex == null || factor === 0
              ? 0
              : Math.sign(index - cursorIndex) * lerp(0, 3, factor);
          // Only the focused tick is dark; neighbors stay muted while growing.
          const isPeak = isHovered || (cursorIndex != null && distanceSlots < 0.5);

          return (
            <button
              key={message.id}
              type="button"
              className="absolute left-1/2 flex items-center justify-center outline-none"
              style={{
                top: restCenter + push,
                width: 28,
                height: Math.max(height + 4, slotPx),
                transform: 'translate(-50%, -50%)',
                transition: 'top 90ms ease-out',
              }}
              aria-label={`Jump to message ${index + 1}`}
              aria-current={isActive ? 'true' : undefined}
              onMouseEnter={() => setHoveredId(message.id)}
              onFocus={() => setHoveredId(message.id)}
              onBlur={() => setHoveredId(null)}
              onClick={() => handleNavigate(message.id)}
            >
              <span
                className={`block rounded-full transition-[width,height,background-color] duration-75 ease-out ${
                  isPeak ? 'bg-text-primary' : 'bg-text-muted'
                }`}
                style={{ width, height }}
              />
            </button>
          );
        })}

        {hoveredMessage && hoveredIndex >= 0 ? (
          <div
            className="pointer-events-none absolute left-9 z-30 w-60 max-w-[min(15rem,calc(100vw-6rem))] rounded-xl border border-border-subtle bg-surface px-3 py-2.5 shadow-soft"
            style={{
              top: (hoveredIndex + 0.5) * slotPx,
              transform: 'translateY(-50%)',
            }}
          >
            <p className="line-clamp-2 text-[12px] leading-snug text-text-primary">
              {truncatePreview(previewText(hoveredMessage)) || 'Message'}
            </p>
            {assistantPreviewByUserId.get(hoveredMessage.id) ? (
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-text-muted">
                {assistantPreviewByUserId.get(hoveredMessage.id)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </nav>
  );
}
