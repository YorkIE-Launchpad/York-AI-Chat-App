import type { CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { parseAccelerator } from '../../../../shared/screen-snap';
import './tipDemo.css';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

const MAC_KEYS: Record<string, string> = {
  Command: '⌘',
  Shift: '⇧',
  Option: '⌥',
  Control: '⌃',
};
const OTHER_KEYS: Record<string, string> = {
  Command: 'Ctrl',
  Shift: 'Shift',
  Option: 'Alt',
  Control: 'Ctrl',
};

/** Accelerator → key cap labels, using glyphs on macOS and words elsewhere. */
export function acceleratorKeys(accelerator: string): string[] {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return [accelerator];
  const names = isMac ? MAC_KEYS : OTHER_KEYS;
  return [...parsed.modifiers.map((m) => names[m] ?? m), parsed.key];
}

const delayStyle = (delay?: number): CSSProperties | undefined =>
  delay ? { animationDelay: `${delay}s` } : undefined;

interface DemoFrameProps {
  children: ReactNode;
  /** Optional mini app window title; renders a window chrome around the content. */
  windowTitle?: string;
  className?: string;
}

/** Rounded illustration box shared by tip demos. */
export function DemoFrame({ children, windowTitle, className = '' }: DemoFrameProps) {
  return (
    <div
      className={`tip-demo relative h-40 overflow-hidden rounded-xl border border-border-subtle bg-surface-muted ${className}`}
      aria-hidden="true"
    >
      {windowTitle !== undefined ? (
        <div className="absolute inset-3 flex flex-col overflow-hidden rounded-md border border-border-subtle bg-surface shadow-soft">
          <div className="flex h-4 shrink-0 items-center gap-1 border-b border-border-subtle px-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted/40" />
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted/40" />
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted/40" />
            <span className="ml-1 truncate text-[8px] text-text-muted">{windowTitle}</span>
          </div>
          <div className="relative min-h-0 flex-1">{children}</div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/** Key caps that press in sequence each loop. */
export function KeyCombo({
  accelerator,
  delay = 0,
  size = 'md',
}: {
  accelerator: string;
  delay?: number;
  size?: 'sm' | 'md';
}) {
  const sizeClass =
    size === 'sm' ? 'h-5 min-w-5 px-1 text-[9px]' : 'h-6 min-w-6 px-1.5 text-[11px]';
  return (
    <span className="inline-flex items-center gap-1">
      {acceleratorKeys(accelerator).map((key, i) => (
        <kbd
          key={`${key}-${i}`}
          className={`tip-demo-key inline-flex items-center justify-center rounded-md border border-border bg-surface font-sans font-semibold text-text-primary shadow-soft ${sizeClass}`}
          style={delayStyle(delay + i * 0.08)}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Wrapper that pops its content in after the key press / typing step.
 * The animation owns `transform`, so position with insets/margins, not translate utilities.
 */
export function PopIn({
  children,
  delay,
  className = '',
}: {
  children?: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div className={`tip-demo-pop ${className}`} style={delayStyle(delay)}>
      {children}
    </div>
  );
}

/** Text that types itself out each loop. */
export function TypeText({ text, delay }: { text: string; delay?: number }) {
  return (
    <span className="tip-demo-type inline-block whitespace-nowrap" style={delayStyle(delay)}>
      {text}
    </span>
  );
}

/** Highlights its child with a press + ring, as if it was clicked. */
export function Tap({
  children,
  delay,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <span
        className="tip-demo-ring pointer-events-none absolute -inset-1 rounded-full border-2 border-accent"
        style={delayStyle(delay)}
      />
      <span className="tip-demo-pulse inline-flex" style={delayStyle(delay)}>
        {children}
      </span>
    </span>
  );
}

interface MiniComposerProps {
  text: string;
  placeholder?: string;
  /** Popover shown above the input (e.g. slash menu). */
  menu?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}

/** Chat input that types `text`, with optional popover menu and side controls. */
export function MiniComposer({
  text,
  placeholder,
  menu,
  leading,
  trailing,
  className = '',
}: MiniComposerProps) {
  return (
    <div className={`relative ${className}`}>
      {menu && <PopIn className="absolute bottom-full left-0 mb-1.5 w-full">{menu}</PopIn>}
      <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2 shadow-soft">
        {leading}
        <span className="relative min-w-0 flex-1 truncate text-[10px] text-text-primary">
          {placeholder && (
            <span className="absolute inset-0 truncate text-text-muted">{placeholder}</span>
          )}
          <span className="relative bg-background">
            <TypeText text={text} />
          </span>
          <span className="tip-demo-caret ml-px inline-block h-2.5 w-px translate-y-0.5 bg-accent" />
        </span>
        {trailing}
      </div>
    </div>
  );
}

export interface MiniListRow {
  icon?: LucideIcon;
  label: string;
  meta?: string;
  /** Small colored tag shown before the meta text. */
  tag?: string;
}

const ROW_HEIGHT = 22;

/** List with a highlight that steps down the rows each loop. */
export function MiniList({ rows, className = '' }: { rows: MiniListRow[]; className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-border-subtle bg-surface ${className}`}
      style={
        {
          '--tip-demo-rows': rows.length,
          '--tip-demo-row-height': `${ROW_HEIGHT}px`,
        } as CSSProperties
      }
    >
      <div
        className="tip-demo-highlight absolute inset-x-0 top-0 bg-accent/15 border-l-2 border-accent"
        style={{ height: ROW_HEIGHT }}
      />
      {rows.map(({ icon: Icon, label, meta, tag }) => (
        <div
          key={label}
          className="relative flex items-center gap-1.5 px-2 text-[9px]"
          style={{ height: ROW_HEIGHT }}
        >
          {Icon && <Icon className="h-3 w-3 shrink-0 text-text-muted" />}
          <span className="min-w-0 flex-1 truncate text-text-primary">{label}</span>
          {tag && (
            <span className="shrink-0 rounded bg-accent/15 px-1 text-[8px] font-medium text-accent">
              {tag}
            </span>
          )}
          {meta && <span className="shrink-0 text-text-muted">{meta}</span>}
        </div>
      ))}
    </div>
  );
}

/** Small accent pill label used to call out a step. */
export function Callout({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-accent px-1.5 py-px text-[9px] font-semibold text-white shadow-soft ${className}`}
    >
      {children}
    </span>
  );
}

/** Animated audio bars for voice / dictation demos. */
export function VoiceBars({ count = 5 }: { count?: number }) {
  return (
    <span className="inline-flex h-3 items-center gap-px">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="tip-demo-wave h-full w-0.5 origin-center rounded bg-accent"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}
