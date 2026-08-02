import { useMemo, useState } from 'react';
import type { MatterItem, MatterOrbit } from '../../../shared/matter';

const ORBIT_RADIUS: Record<MatterOrbit, number> = {
  now: 52,
  today: 88,
  week: 124,
  watching: 160,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  healthy: '#22c55e',
  signal: '#00b48a',
};

function hashAngle(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

interface MatterRadarProps {
  items: MatterItem[];
  selectedId: string | null;
  highlightedIds: Set<string>;
  pulse: string;
  onSelect: (id: string) => void;
}

export function MatterRadar({
  items,
  selectedId,
  highlightedIds,
  pulse,
  onSelect,
}: MatterRadarProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const blips = useMemo(() => {
    return items.map((item) => {
      const r = ORBIT_RADIUS[item.orbit] || ORBIT_RADIUS.watching;
      const angle = (hashAngle(item.id) * Math.PI) / 180;
      const jitter = ((hashAngle(item.fingerprint) % 20) - 10) * 0.4;
      return {
        item,
        x: 200 + Math.cos(angle) * (r + jitter),
        y: 200 + Math.sin(angle) * (r + jitter),
        r: item.severity === 'critical' ? 6 : item.severity === 'warning' ? 5 : 4,
        color: SEVERITY_COLOR[item.severity] || SEVERITY_COLOR.signal,
      };
    });
  }, [items]);

  const hoveredItem = blips.find((b) => b.item.id === hovered)?.item;

  return (
    <div className="relative flex flex-col items-center justify-center">
      <svg
        viewBox="0 0 400 400"
        className="w-full max-w-[420px] aspect-square drop-shadow-sm"
        role="img"
        aria-label="Matter radar"
      >
        <defs>
          <radialGradient id="matterCore" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--color-accent, #00b48a)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--color-accent, #00b48a)" stopOpacity="0.35" />
          </radialGradient>
          <style>{`
            @keyframes matterOrbitSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            @keyframes matterPulse { 0%,100% { opacity: 0.45; } 50% { opacity: 0.9; } }
            .matter-orbit-ring { transform-origin: 200px 200px; animation: matterOrbitSpin 80s linear infinite; }
            .matter-blip-pulse { animation: matterPulse 2.8s ease-in-out infinite; }
          `}</style>
        </defs>

        <circle
          cx="200"
          cy="200"
          r="180"
          fill="transparent"
          stroke="currentColor"
          strokeOpacity="0.08"
        />
        <g className="matter-orbit-ring text-text-muted">
          {[52, 88, 124, 160].map((r) => (
            <circle
              key={r}
              cx="200"
              cy="200"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.22"
              strokeDasharray="2 6"
            />
          ))}
        </g>

        <circle cx="200" cy="200" r="34" fill="url(#matterCore)" />
        <circle
          cx="200"
          cy="200"
          r="34"
          fill="none"
          stroke="var(--color-accent, #00b48a)"
          strokeOpacity="0.5"
          className="matter-blip-pulse"
        />
        <text
          x="200"
          y="196"
          textAnchor="middle"
          className="fill-white"
          style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5 }}
        >
          MATTER
        </text>
        <text
          x="200"
          y="212"
          textAnchor="middle"
          className="fill-white"
          style={{ fontSize: 7, opacity: 0.85 }}
        >
          what needs you
        </text>

        {blips.map((blip) => {
          const active =
            blip.item.id === selectedId ||
            blip.item.id === hovered ||
            highlightedIds.has(blip.item.id);
          const dimmed = highlightedIds.size > 0 && !highlightedIds.has(blip.item.id);
          return (
            <g key={blip.item.id}>
              <circle
                cx={blip.x}
                cy={blip.y}
                r={active ? blip.r + 4 : blip.r + 2}
                fill={blip.color}
                opacity={dimmed ? 0.15 : 0.2}
                className={blip.item.severity === 'critical' ? 'matter-blip-pulse' : undefined}
              />
              <circle
                cx={blip.x}
                cy={blip.y}
                r={active ? blip.r + 1 : blip.r}
                fill={blip.color}
                opacity={dimmed ? 0.25 : 1}
                className="cursor-pointer"
                onMouseEnter={() => setHovered(blip.item.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onSelect(blip.item.id)}
              />
            </g>
          );
        })}
      </svg>

      <p className="mt-2 max-w-md text-center text-sm text-text-secondary px-4">{pulse}</p>

      {hoveredItem ? (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 w-[min(320px,90%)] rounded-xl border border-border-muted bg-surface/95 px-3 py-2 shadow-lg pointer-events-none">
          <div className="text-xs font-semibold text-text-primary truncate">
            {hoveredItem.title}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 line-clamp-2">
            {hoveredItem.whyItMatters}
          </div>
        </div>
      ) : null}
    </div>
  );
}
