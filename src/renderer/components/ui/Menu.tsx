import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | 'separator';

interface MenuProps {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: MenuEntry[];
  align?: 'left' | 'right';
  side?: 'bottom' | 'top';
  className?: string;
  menuClassName?: string;
}

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 6;
const FALLBACK_MENU_WIDTH = 208;

interface MenuCoords {
  top: number;
  left: number;
}

function placeMenu(
  anchor: HTMLElement,
  menu: HTMLElement,
  align: 'left' | 'right',
  side: 'bottom' | 'top'
): MenuCoords {
  const rect = anchor.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || FALLBACK_MENU_WIDTH;
  const menuHeight = menu.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = align === 'right' ? rect.right - menuWidth : rect.left;
  let top = side === 'bottom' ? rect.bottom + MENU_GAP : rect.top - MENU_GAP - menuHeight;

  if (left + menuWidth > viewportWidth - VIEWPORT_MARGIN) {
    left = rect.right - menuWidth;
  }
  if (left < VIEWPORT_MARGIN) left = rect.left;
  left = Math.min(Math.max(VIEWPORT_MARGIN, left), viewportWidth - VIEWPORT_MARGIN - menuWidth);

  const overflowsBottom = top + menuHeight > viewportHeight - VIEWPORT_MARGIN;
  const overflowsTop = top < VIEWPORT_MARGIN;
  if (side === 'bottom' && overflowsBottom) top = rect.top - MENU_GAP - menuHeight;
  if (side === 'top' && overflowsTop) top = rect.bottom + MENU_GAP;
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;
  if (top + menuHeight > viewportHeight - VIEWPORT_MARGIN) {
    top = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - menuHeight);
  }

  return { top, left };
}

export function Menu({
  trigger,
  items,
  align = 'right',
  side = 'bottom',
  className = '',
  menuClassName = '',
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const update = () => {
      const anchor = rootRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const next = placeMenu(anchor, menu, align, side);
      setCoords((prev) =>
        prev && Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.left - next.left) < 0.5
          ? prev
          : next
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, align, side, items]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const menu =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              visibility: coords ? 'visible' : 'hidden',
            }}
            className={`fixed z-[80] min-w-[13rem] rounded-xl border border-border-subtle bg-surface-raised p-1 shadow-elevated animate-fade-in ${menuClassName}`}
          >
            {items.map((entry, index) =>
              entry === 'separator' ? (
                <div key={`sep-${index}`} className="my-1 h-px bg-border-subtle" />
              ) : (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitem"
                  disabled={entry.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    entry.onSelect();
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-40 ${
                    entry.danger
                      ? 'text-error hover:bg-error/10'
                      : 'text-text-primary hover:bg-surface-hover'
                  }`}
                >
                  {entry.icon ? (
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted">
                      {entry.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.hint ? <span className="kbd">{entry.hint}</span> : null}
                </button>
              )
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {menu}
    </div>
  );
}
