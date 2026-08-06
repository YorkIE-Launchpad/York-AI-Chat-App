import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Skill } from '../types';

interface SlashCommandMenuProps {
  open: boolean;
  skills: Skill[];
  selectedIndex: number;
  onSelect: (skill: Skill) => void;
  onHoverIndex: (index: number) => void;
  onClose: () => void;
}

type MenuBox = {
  left: number;
  width: number;
  bottom: number;
};

/**
 * Slash skill picker. Portaled to document.body with a solid surface fill so chat
 * text never bleeds through (semi-transparent parent layers otherwise composite
 * the menu as translucent over message content).
 */
export function SlashCommandMenu({
  open,
  skills,
  selectedIndex,
  onSelect,
  onHoverIndex,
  onClose,
}: SlashCommandMenuProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<MenuBox | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }

    const update = () => {
      const parent = anchorRef.current?.offsetParent as HTMLElement | null;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      setBox({
        left: rect.left,
        width: rect.width,
        // Gap above the composer, same as previous bottom-[calc(100%+8px)]
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
      });
    };

    update();
    window.addEventListener('resize', update);
    // Composer may grow as the user types; keep the menu snug above it
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, skills.length]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.parentElement?.contains(target)) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const menu =
    open && box
      ? createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Skills"
            className="fixed z-[80] overflow-hidden rounded-[1.25rem] border border-border shadow-elevated isolate"
            style={{
              left: box.left,
              width: box.width,
              bottom: box.bottom,
              // Force fully opaque surface — never use translucent tokens / blur here
              backgroundColor: 'var(--color-surface)',
              opacity: 1,
              backdropFilter: 'none',
              WebkitBackdropFilter: 'none',
            }}
          >
            <div
              className="border-b border-border-subtle px-3 py-2 text-[11px] font-medium tracking-[0.04em] text-text-muted"
              style={{ backgroundColor: 'var(--color-surface)' }}
            >
              Skills · / or @
            </div>
            <div
              className="max-h-64 overflow-y-auto py-1.5"
              style={{ backgroundColor: 'var(--color-surface)' }}
            >
              {skills.length === 0 ? (
                <div className="px-3 py-2 text-[13px] text-text-muted">No matching skills</div>
              ) : (
                <div className="space-y-0.5 px-1.5">
                  {skills.map((skill, index) => {
                    const isSelected = index === selectedIndex;
                    return (
                      <button
                        key={skill.id}
                        ref={isSelected ? selectedRef : undefined}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onMouseEnter={() => onHoverIndex(index)}
                        onClick={() => onSelect(skill)}
                        className={`flex w-full flex-col gap-0.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
                          isSelected
                            ? 'bg-accent-muted text-text-primary'
                            : 'text-text-primary hover:bg-surface-hover'
                        }`}
                      >
                        <span className="text-[13px] font-medium">
                          <span className={isSelected ? 'text-accent' : undefined}>
                            /{skill.name}
                          </span>
                          {skill.argumentHint ? (
                            <span className="ml-1.5 font-normal text-text-muted">
                              {skill.argumentHint}
                            </span>
                          ) : null}
                        </span>
                        {skill.description ? (
                          <span className="line-clamp-2 text-[12px] leading-snug text-text-secondary">
                            {skill.description}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      {/* Anchor lives inside the relative composer so we can measure its box */}
      <div
        ref={anchorRef}
        className="pointer-events-none absolute inset-x-0 bottom-full h-0"
        aria-hidden
      />
      {menu}
    </>
  );
}
