import { useEffect, useRef, useState, type ReactNode } from 'react';

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

export function Menu({
  trigger,
  items,
  align = 'right',
  side = 'bottom',
  className = '',
  menuClassName = '',
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open ? (
        <div
          role="menu"
          className={`absolute z-50 min-w-[13rem] rounded-xl border border-border-subtle bg-surface-raised p-1 shadow-elevated animate-fade-in ${
            align === 'right' ? 'right-0' : 'left-0'
          } ${side === 'bottom' ? 'top-[calc(100%+6px)]' : 'bottom-[calc(100%+6px)]'} ${menuClassName}`}
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
        </div>
      ) : null}
    </div>
  );
}
