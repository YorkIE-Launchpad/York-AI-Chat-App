import { useState, type AnimationEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Crosshair,
  FileText,
  Globe,
  Mail,
  MessageSquare,
  Monitor,
  MousePointer2,
  Send,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import './snapWiggleDemo.css';

interface DemoScene {
  id: 'mail' | 'browser' | 'chat' | 'notes';
  appName: string;
  icon: LucideIcon;
}

/** Each loop of the demo plays in the next app to show it works anywhere. */
const SCENES: DemoScene[] = [
  { id: 'mail', appName: 'Mail', icon: Mail },
  { id: 'browser', appName: 'Chrome', icon: Globe },
  { id: 'chat', appName: 'Slack', icon: MessageSquare },
  { id: 'notes', appName: 'Notes', icon: FileText },
];

/** Looping mini-desktop: wiggle → select an area → chat → insert into the app's text field. */
export function SnapWiggleDemo() {
  const { t } = useTranslation();
  const [sceneIndex, setSceneIndex] = useState(0);
  const scene = SCENES[sceneIndex];

  const nextScene = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setSceneIndex((i) => (i + 1) % SCENES.length);
  };

  return (
    <div
      className="snap-demo relative h-44 overflow-hidden rounded-xl border border-border-subtle bg-surface-muted"
      aria-hidden="true"
    >
      <div className="snap-demo-stage absolute inset-0" onAnimationIteration={nextScene}>
        {/* Menu bar */}
        <div className="absolute inset-x-0 top-0 flex h-5 items-center gap-2 border-b border-border-subtle bg-surface/80 px-2 text-[9px]">
          <span className="h-1.5 w-1.5 rounded-full bg-text-primary/70" />
          <span className="font-semibold text-text-primary">{scene.appName}</span>
          <span className="text-text-muted">File&nbsp;&nbsp;Edit&nbsp;&nbsp;View</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent/15 px-1.5 py-px font-medium text-accent">
            <Monitor className="h-2.5 w-2.5" />
            {t('tips.snapWiggle.anywhere')}
          </span>
        </div>

        {/* App window */}
        <div className="absolute inset-x-3 bottom-9 top-7 rounded-md border border-border-subtle bg-surface shadow-soft">
          <div className="flex h-4 items-center gap-1 border-b border-border-subtle px-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted/40" />
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted/40" />
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted/40" />
            <scene.icon className="ml-1 h-2.5 w-2.5 text-text-muted" />
          </div>
          <div className="space-y-1.5 p-2 pt-2.5">
            <div className="h-1 w-28 rounded bg-text-muted/30" />
            <div className="h-1 w-24 rounded bg-text-muted/25" />
            <div className="h-1 w-20 rounded bg-text-muted/25" />
            <div className="h-1 w-16 rounded bg-text-muted/20" />
          </div>

          {/* Target text field */}
          <div className="snap-demo-field absolute inset-x-2 bottom-2 z-20 flex h-5 items-center rounded border border-border-subtle bg-background px-1.5">
            <span className="snap-demo-placeholder absolute left-1.5 text-[8px] text-text-muted">
              {t(`tips.snapWiggle.scenes.${scene.id}`)}
            </span>
            <span className="snap-demo-inserted flex items-center gap-1">
              <span className="h-1 w-16 rounded bg-text-primary/60" />
              <span className="h-1 w-10 rounded bg-text-primary/60" />
              <span className="h-1 w-6 rounded bg-text-primary/60" />
            </span>
          </div>
          <span className="snap-demo-done absolute bottom-8 left-2 z-20 inline-flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-px text-[8px] font-semibold text-white shadow-soft">
            <Check className="h-2.5 w-2.5" />
            {t('tips.snapWiggle.insertedLabel')}
          </span>
        </div>

        {/* Dock */}
        <div className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface/80 px-1.5 py-1">
          {SCENES.map(({ id, icon: Icon }) => (
            <span
              key={id}
              className={`flex h-4 w-4 items-center justify-center rounded transition-colors duration-300 ${
                id === scene.id ? 'bg-accent text-white' : 'bg-surface-hover text-text-muted'
              }`}
            >
              <Icon className="h-2.5 w-2.5" />
            </span>
          ))}
        </div>

        {/* Screen selector */}
        <span className="snap-demo-select-label absolute left-[22px] top-[33px] z-10 rounded-full bg-accent px-1.5 py-px text-[8px] font-semibold text-white shadow-soft">
          {t('tips.snapWiggle.selectLabel')}
        </span>
        <div className="snap-demo-selection absolute left-[22px] top-[48px] z-10 rounded-sm">
          <Crosshair className="snap-demo-crosshair absolute -bottom-2 -right-2 h-4 w-4 text-text-primary" />
        </div>

        {/* Wiggling pointer */}
        <div className="absolute left-[44px] top-[62px] z-10">
          <span className="snap-demo-wiggle-label absolute -top-6 left-0 whitespace-nowrap rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-white shadow-soft">
            {t('tips.snapWiggle.wiggleLabel')}
          </span>
          <span className="snap-demo-ripple absolute -left-3 -top-3 h-8 w-8 rounded-full border-2 border-accent" />
          <div className="snap-demo-pointer">
            <MousePointer2 className="h-5 w-5 fill-text-primary text-surface drop-shadow" />
          </div>
        </div>

        {/* Snap chat panel */}
        <div className="snap-demo-panel absolute right-4 top-8 z-30 w-[136px] rounded-lg border border-border bg-surface p-2 shadow-elevated">
          <div className="mb-1.5 flex items-center gap-1">
            <Sparkles className="h-2.5 w-2.5 text-accent" />
            <span className="h-1 w-10 rounded bg-text-muted/40" />
          </div>
          <div className="mb-1.5 space-y-1 rounded border border-dashed border-accent/60 bg-accent/10 p-1">
            <div className="h-0.5 w-14 rounded bg-text-muted/40" />
            <div className="h-0.5 w-10 rounded bg-text-muted/40" />
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border-subtle bg-background px-1.5 py-1">
            <span className="snap-demo-typed min-w-0 flex-1 truncate text-[8px] text-text-primary">
              {t(`tips.snapWiggle.instructions.${scene.id}`)}
            </span>
            <Send className="h-2.5 w-2.5 shrink-0 text-accent" />
          </div>
          <div className="snap-demo-reply mt-1.5 space-y-1">
            <div className="h-1 w-full rounded bg-text-muted/30" />
            <div className="h-1 w-3/4 rounded bg-text-muted/30" />
          </div>
          <div className="mt-1.5 flex justify-end">
            <span className="snap-demo-insert-btn rounded bg-accent px-1.5 py-px text-[8px] font-semibold text-white">
              {t('tips.snapWiggle.insertButton')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
