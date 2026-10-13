import { useLayoutEffect, useState, type RefObject } from 'react';

export interface MenuPlacement {
  direction: 'up' | 'down';
  maxHeight: number;
}

const GAP = 16;
const MIN_HEIGHT = 160;

/**
 * Picks whether a composer popover opens above or below its anchor, and how tall it may be,
 * based on the space left inside every scrolling/clipping ancestor (not just the viewport).
 */
export function useMenuPlacement(
  anchorRef: RefObject<HTMLElement>,
  open: boolean,
  preferredHeight: number
): MenuPlacement {
  const [placement, setPlacement] = useState<MenuPlacement>({
    direction: 'up',
    maxHeight: preferredHeight,
  });

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const measure = () => {
      let top = 0;
      let bottom = window.innerHeight;
      for (let el = anchor.parentElement; el; el = el.parentElement) {
        if (getComputedStyle(el).overflowY !== 'visible') {
          const rect = el.getBoundingClientRect();
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      const rect = anchor.getBoundingClientRect();
      const spaceAbove = rect.top - top - GAP;
      const spaceBelow = bottom - rect.bottom - GAP;
      const direction = spaceAbove >= preferredHeight || spaceAbove >= spaceBelow ? 'up' : 'down';
      const available = direction === 'up' ? spaceAbove : spaceBelow;
      setPlacement({
        direction,
        maxHeight: Math.max(MIN_HEIGHT, Math.min(preferredHeight, available)),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchorRef, open, preferredHeight]);

  return placement;
}
