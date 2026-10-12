import { useEffect, useRef, useState } from 'react';
import type { ChatLoopStatus } from '../../types';

/** Connected MCP servers for the header badge, and whether its label fits beside the title. */
export function useHeaderConnectors(isElectron: boolean, chatLoopStatus: ChatLoopStatus | null) {
  const [activeConnectors, setActiveConnectors] = useState<
    { id: string; name: string; connected: boolean; toolCount: number }[]
  >([]);
  const [showConnectorLabel, setShowConnectorLabel] = useState(true);
  const headerRef = useRef<HTMLDivElement>(null);
  const rightActionsRef = useRef<HTMLDivElement>(null);
  const connectorMeasureRef = useRef<HTMLDivElement>(null);
  const connectorBadgeRef = useRef<HTMLDivElement>(null);

  // Load active MCP connectors
  useEffect(() => {
    if (isElectron && typeof window !== 'undefined' && window.electronAPI) {
      const loadConnectors = async () => {
        try {
          const statuses = await window.electronAPI.mcp.getServerStatus();
          const active =
            (
              statuses as Array<{ id: string; name: string; connected: boolean; toolCount: number }>
            )?.filter((s) => s.connected && s.toolCount > 0) || [];
          setActiveConnectors(active);
        } catch (err) {
          console.error('Failed to load MCP connectors:', err);
        }
      };
      loadConnectors();
      // Refresh every 5 seconds
      const interval = setInterval(loadConnectors, 5000);
      return () => clearInterval(interval);
    }
  }, [isElectron]);

  useEffect(() => {
    const headerEl = headerRef.current;
    const rightEl = rightActionsRef.current;
    const measureEl = connectorMeasureRef.current;
    const badgeEl = connectorBadgeRef.current;
    if (!headerEl || !rightEl || !measureEl || !badgeEl) {
      setShowConnectorLabel(true);
      return;
    }
    const updateLabelVisibility = () => {
      const headerStyles = window.getComputedStyle(headerEl);
      const rightStyles = window.getComputedStyle(rightEl);
      const headerGap = Number.parseFloat(headerStyles.columnGap || headerStyles.gap) || 0;
      const rightGap = Number.parseFloat(rightStyles.columnGap || rightStyles.gap) || 0;
      const padLeft = Number.parseFloat(headerStyles.paddingLeft) || 0;
      const padRight = Number.parseFloat(headerStyles.paddingRight) || 0;

      // Brand is the first header child; leave a modest min width for the title.
      const brandEl = headerEl.firstElementChild;
      const brandWidth = brandEl instanceof HTMLElement ? brandEl.getBoundingClientRect().width : 0;
      const minTitleWidth = 72;

      let usedByActionSiblings = 0;
      let actionSiblingCount = 0;
      for (const child of Array.from(rightEl.children)) {
        if (child === measureEl || child === badgeEl) continue;
        if (!(child instanceof HTMLElement)) continue;
        if (child.getAttribute('aria-hidden') === 'true') continue;
        usedByActionSiblings += child.getBoundingClientRect().width;
        actionSiblingCount += 1;
      }
      // Gaps: brand–title, title–actions, plus between action siblings and the badge.
      const layoutGaps = headerGap * 2 + rightGap * actionSiblingCount;
      const reserved =
        padLeft + padRight + brandWidth + minTitleWidth + usedByActionSiblings + layoutGaps;
      const availableForBadge = Math.max(0, headerEl.clientWidth - reserved);
      const connectorFullWidth = measureEl.getBoundingClientRect().width;
      setShowConnectorLabel(availableForBadge >= connectorFullWidth);
    };
    updateLabelVisibility();
    const observer = new ResizeObserver(() => {
      updateLabelVisibility();
    });
    observer.observe(headerEl);
    observer.observe(rightEl);
    return () => observer.disconnect();
  }, [activeConnectors.length, chatLoopStatus]);

  return {
    activeConnectors,
    showConnectorLabel,
    headerRef,
    rightActionsRef,
    connectorMeasureRef,
    connectorBadgeRef,
  };
}
