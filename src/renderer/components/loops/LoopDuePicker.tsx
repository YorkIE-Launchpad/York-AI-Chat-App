import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const POPOVER_WIDTH = 248;
const DUE_HOUR = 17;

interface LoopDuePickerProps {
  anchor: HTMLElement;
  value: number | null;
  onSelect: (dueAt: number | null) => void;
  onDismiss: () => void;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function atDueHour(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), DUE_HOUR, 0, 0, 0).getTime();
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function nextWeekday(from: Date, weekday: number): Date {
  const diff = (weekday - from.getDay() + 7) % 7 || 7;
  return addDays(from, diff);
}

export function LoopDuePicker({ anchor, value, onSelect, onDismiss }: LoopDuePickerProps) {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const today = useMemo(() => startOfDay(new Date()), []);
  const selected = value != null ? startOfDay(new Date(value)) : null;
  const [month, setMonth] = useState(() => {
    const base = selected ?? today;
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const height = ref.current?.offsetHeight ?? 320;
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - POPOVER_WIDTH - 8);
      const below = rect.bottom + 6;
      const top =
        below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onDismiss]);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: 'narrow' });
    // 2023-01-01 is a Sunday.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
  }, [i18n.language]);

  const days = useMemo(() => {
    const first = addDays(month, -month.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  }, [month]);

  const quickPicks: Array<{ label: string; date: Date }> = [
    { label: t('loops.dueToday'), date: today },
    { label: t('loops.dueTomorrow'), date: addDays(today, 1) },
    { label: t('loops.dueFriday'), date: today.getDay() === 5 ? today : nextWeekday(today, 5) },
    { label: t('loops.dueNextWeek'), date: nextWeekday(today, 1) },
  ];

  const pick = (date: Date | null) => onSelect(date ? atDueHour(date) : null);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: POPOVER_WIDTH }}
      className="fixed z-50 rounded-xl border border-border-muted bg-surface p-2 shadow-lg"
    >
      <div className="grid grid-cols-2 gap-1">
        {quickPicks.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => pick(q.date)}
            className={`rounded-lg px-2 py-1 text-left text-[11px] transition-colors ${
              selected && sameDay(selected, q.date)
                ? 'bg-accent/15 text-accent'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }`}
          >
            <span className="font-medium">{q.label}</span>
            <span className="ml-1 text-text-muted">
              {q.date.toLocaleDateString(i18n.language, { weekday: 'short' })}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-2 border-t border-border-subtle pt-2">
        <div className="mb-1 flex items-center justify-between px-1">
          <button
            type="button"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            className="rounded-md p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
            aria-label={t('loops.prevMonth')}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-[12px] font-semibold text-text-primary">
            {month.toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' })}
          </span>
          <button
            type="button"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            className="rounded-md p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
            aria-label={t('loops.nextMonth')}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-7 text-center text-[10px] text-text-muted">
          {weekdayLabels.map((label, i) => (
            <span key={i} className="py-0.5">
              {label}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {days.map((day) => {
            const inMonth = day.getMonth() === month.getMonth();
            const isSelected = selected ? sameDay(day, selected) : false;
            const isToday = sameDay(day, today);
            const isPast = day < today;
            return (
              <button
                key={day.getTime()}
                type="button"
                onClick={() => pick(day)}
                className={`h-7 rounded-md text-[11px] transition-colors ${
                  isSelected
                    ? 'bg-accent text-white font-semibold'
                    : isToday
                      ? 'text-accent font-semibold ring-1 ring-inset ring-accent/40 hover:bg-accent/10'
                      : inMonth
                        ? `${isPast ? 'text-text-muted' : 'text-text-primary'} hover:bg-surface-hover`
                        : 'text-text-muted/50 hover:bg-surface-hover'
                }`}
              >
                {day.getDate()}
              </button>
            );
          })}
        </div>
      </div>

      {value != null ? (
        <div className="mt-2 border-t border-border-subtle pt-2">
          <button
            type="button"
            onClick={() => pick(null)}
            className="w-full rounded-lg px-2 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          >
            {t('loops.clearDue')}
          </button>
        </div>
      ) : null}
    </div>,
    document.body
  );
}
