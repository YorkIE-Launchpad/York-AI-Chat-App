import { useEffect, useRef } from 'react';
import type { Skill } from '../types';

interface SlashCommandMenuProps {
  open: boolean;
  skills: Skill[];
  selectedIndex: number;
  onSelect: (skill: Skill) => void;
  onHoverIndex: (index: number) => void;
  onClose: () => void;
}

export function SlashCommandMenu({
  open,
  skills,
  selectedIndex,
  onSelect,
  onHoverIndex,
  onClose,
}: SlashCommandMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose();
      }
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

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role="listbox"
      aria-label="Skills"
      className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-30 overflow-hidden rounded-[1.25rem] border border-border-subtle bg-background/96 shadow-elevated backdrop-blur-md"
    >
      <div className="border-b border-border-subtle px-3 py-2 text-[11px] font-medium tracking-[0.04em] text-text-muted">
        Skills
      </div>
      <div className="max-h-64 overflow-y-auto py-1.5">
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
                    <span className={isSelected ? 'text-accent' : undefined}>/{skill.name}</span>
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
    </div>
  );
}
