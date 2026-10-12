import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatterItem, MatterOrbit, MatterSource } from '../../../shared/matter';

/** Ring = orbit (same groups as the list), slice = source, stroke = severity. */
const ORBIT_R: Record<MatterOrbit, number> = { now: 58, today: 92, week: 122, watching: 148 };
const RING_OFFSET = 19;
const ORBITS: MatterOrbit[] = ['now', 'today', 'week', 'watching'];

export type RadarSliceId = 'gmail' | 'slack' | 'jira' | 'hub' | 'meetings' | 'drive';

export const RADAR_SLICES: Array<{ id: RadarSliceId; label: string; abbr: string; color: string }> =
  [
    { id: 'gmail', label: 'Gmail', abbr: 'M', color: '#c5221f' },
    { id: 'slack', label: 'Slack', abbr: 'S', color: '#4a154b' },
    { id: 'jira', label: 'Jira', abbr: 'J', color: '#0c66e4' },
    { id: 'hub', label: 'Hub', abbr: 'H', color: '#00876a' },
    { id: 'meetings', label: 'Meetings', abbr: 'C', color: '#1a73e8' },
    { id: 'drive', label: 'Drive', abbr: 'D', color: '#3c6e47' },
  ];

const SEVERITY_STROKE: Record<string, string> = {
  critical: '#f26d5b',
  warning: '#e8b13c',
  healthy: '#2fbf71',
  signal: '#00b48a',
};

export function radarSliceForSource(source: MatterSource): RadarSliceId {
  switch (source) {
    case 'gmail':
      return 'gmail';
    case 'slack':
      return 'slack';
    case 'jira':
      return 'jira';
    case 'calendar':
    case 'meeting':
      return 'meetings';
    case 'drive':
      return 'drive';
    default:
      return 'hub';
  }
}

const SLICE_DEG = 360 / RADAR_SLICES.length;
const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
const pt = (r: number, deg: number): [number, number] => [
  200 + r * Math.cos(rad(deg)),
  200 + r * Math.sin(rad(deg)),
];

interface TodayRadarProps {
  items: MatterItem[];
  scanning: boolean;
  hoveredId: string | null;
  /** Items outside the active filter render dimmed. */
  highlightedIds: Set<string> | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

export function TodayRadar({
  items,
  scanning,
  hoveredId,
  highlightedIds,
  onHover,
  onSelect,
}: TodayRadarProps) {
  const { t } = useTranslation();
  const nowCount = items.filter((i) => i.orbit === 'now').length;

  const blips = useMemo(() => {
    const groups = new Map<string, MatterItem[]>();
    for (const item of items) {
      const key = `${radarSliceForSource(item.source)}:${item.orbit}`;
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    const out: Array<{
      item: MatterItem;
      x: number;
      y: number;
      size: number;
      color: string;
      abbr: string;
    }> = [];
    const overflow: Array<{ key: string; x: number; y: number; count: number; first: MatterItem }> =
      [];
    for (const [key, list] of groups.entries()) {
      const orbit = list[0].orbit;
      const r = (ORBIT_R[orbit] ?? ORBIT_R.watching) + RING_OFFSET;
      const sliceIndex = RADAR_SLICES.findIndex(
        (s) => s.id === radarSliceForSource(list[0].source)
      );
      const slice = RADAR_SLICES[sliceIndex];
      const center = sliceIndex * SLICE_DEG + SLICE_DEG / 2;
      const size = orbit === 'watching' ? 9 : 11;
      // Up to two lanes per ring; each lane holds as many blips as fit in the slice arc.
      const arcDeg = SLICE_DEG - 10;
      const pitch = size * 2 + 3;
      const lanes = [r - 12, r + 12];
      const perLane = lanes.map((lr) =>
        Math.max(1, Math.floor((lr * arcDeg * Math.PI) / 180 / pitch) + 1)
      );
      const sorted = [...list].sort(
        (a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical')
      );
      const singleLane = sorted.length <= perLane[0];
      const total = perLane[0] + perLane[1];
      const capacity = singleLane || sorted.length <= total ? sorted.length : total - 1;
      const shown = sorted.slice(0, sorted.length > capacity ? capacity : sorted.length);
      const hidden = sorted.length - shown.length;
      const placeLane = (laneItems: MatterItem[], lr: number, extraSlot: boolean) => {
        const slots = laneItems.length + (extraSlot ? 1 : 0);
        const step = slots > 1 ? Math.min(16, arcDeg / (slots - 1)) : 0;
        const positions = Array.from({ length: slots }, (_, j) =>
          pt(lr, center + (j - (slots - 1) / 2) * step)
        );
        laneItems.forEach((item, j) => {
          const [x, y] = positions[j];
          out.push({
            item,
            x,
            y,
            size: item.severity === 'critical' ? size + 2 : size,
            color: slice.color,
            abbr: slice.abbr,
          });
        });
        return positions[slots - 1];
      };
      if (singleLane) {
        placeLane(shown, r, false);
      } else {
        placeLane(shown.slice(0, perLane[0]), lanes[0], false);
        const last = placeLane(shown.slice(perLane[0]), lanes[1], hidden > 0);
        if (hidden > 0) {
          overflow.push({
            key,
            x: last[0],
            y: last[1],
            count: hidden,
            first: sorted[shown.length],
          });
        }
      }
    }
    return { out, overflow };
  }, [items]);

  const hovered = hoveredId ? items.find((i) => i.id === hoveredId) : null;
  const dimOthers = Boolean(hoveredId) || Boolean(highlightedIds);
  const [sweepX, sweepY] = pt(178, 90);
  const [sweepStartX, sweepStartY] = pt(178, 50);

  return (
    <figure
      className="today-radar m-0 flex flex-col items-center"
      aria-label={t('today.radar.label')}
    >
      <svg
        viewBox="0 0 400 400"
        className="h-[300px] w-[300px] overflow-visible"
        role="img"
        aria-label={t('today.radar.aria')}
        onMouseLeave={() => onHover(null)}
      >
        <defs>
          <radialGradient id="todayRadarCore">
            <stop offset="0%" stopColor="#00b48a" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#00b48a" stopOpacity="0.45" />
          </radialGradient>
          <linearGradient id="todayRadarSweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#00b48a" stopOpacity="0" />
            <stop offset="1" stopColor="#00b48a" stopOpacity="0.35" />
          </linearGradient>
        </defs>

        <circle cx="200" cy="200" r={ORBIT_R.now + RING_OFFSET} className="today-radar-band" />
        {ORBITS.map((orbit) => (
          <circle
            key={orbit}
            cx="200"
            cy="200"
            r={ORBIT_R[orbit] + RING_OFFSET}
            className={`today-radar-ring ${orbit === 'now' ? 'is-now' : ''}`}
          />
        ))}
        {RADAR_SLICES.map((slice, i) => {
          const [x1, y1] = pt(48, i * SLICE_DEG);
          const [x2, y2] = pt(178, i * SLICE_DEG);
          const [lx, ly] = pt(194, i * SLICE_DEG + SLICE_DEG / 2);
          return (
            <g key={slice.id}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} className="today-radar-sector" />
              <text x={lx} y={ly + 3.5} textAnchor="middle" className="today-radar-src">
                {slice.label.toUpperCase()}
              </text>
            </g>
          );
        })}
        {ORBITS.map((orbit) => (
          <text key={orbit} x="203" y={200 - ORBIT_R[orbit] - 21} className="today-radar-label">
            {t(`today.orbit.${orbit}`).toUpperCase()}
          </text>
        ))}

        <g className={`today-radar-sweep ${scanning ? 'is-scanning' : ''}`} pointerEvents="none">
          <path
            d={`M200 200 L${sweepStartX} ${sweepStartY} A178 178 0 0 1 ${sweepX} ${sweepY} Z`}
            fill="url(#todayRadarSweep)"
          />
          <line
            x1="200"
            y1="200"
            x2={sweepX}
            y2={sweepY}
            stroke="#00b48a"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>

        <circle cx="200" cy="200" r="40" fill="url(#todayRadarCore)" />
        <text x="200" y="205" textAnchor="middle" className="today-radar-core-n">
          {nowCount}
        </text>
        <text x="200" y="220" textAnchor="middle" className="today-radar-core-t">
          {t('today.radar.core').toUpperCase()}
        </text>

        {blips.overflow.map((o) => (
          <g
            key={`more-${o.key}`}
            className="today-radar-blip"
            opacity={dimOthers ? 0.25 : 1}
            tabIndex={0}
            role="button"
            aria-label={t('today.radar.more', { count: o.count })}
            onClick={() => onSelect(o.first.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(o.first.id);
              }
            }}
          >
            <title>{t('today.radar.more', { count: o.count })}</title>
            <circle cx={o.x} cy={o.y} r={11} className="today-radar-more" />
            <text x={o.x} y={o.y + 3.2} textAnchor="middle" className="today-radar-more-t">
              +{o.count}
            </text>
          </g>
        ))}
        {blips.out.map((blip) => {
          const critical = blip.item.severity === 'critical';
          const active =
            blip.item.id === hoveredId ||
            (!hoveredId && highlightedIds ? highlightedIds.has(blip.item.id) : false);
          const stroke = SEVERITY_STROKE[blip.item.severity] ?? SEVERITY_STROKE.signal;
          return (
            <g
              key={blip.item.id}
              className={`today-radar-blip ${critical ? 'is-critical' : ''}`}
              opacity={dimOthers && !active ? 0.25 : 1}
              tabIndex={0}
              role="button"
              aria-label={blip.item.title}
              onMouseEnter={() => onHover(blip.item.id)}
              onFocus={() => onHover(blip.item.id)}
              onBlur={() => onHover(null)}
              onClick={() => onSelect(blip.item.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(blip.item.id);
                }
              }}
            >
              {critical ? (
                <circle
                  className="today-radar-halo"
                  cx={blip.x}
                  cy={blip.y}
                  r={blip.size}
                  fill="none"
                  stroke={SEVERITY_STROKE.critical}
                  strokeWidth="2"
                />
              ) : null}
              <circle
                cx={blip.x}
                cy={blip.y}
                r={active ? blip.size + 2 : blip.size}
                fill={blip.color}
                stroke={stroke}
                strokeWidth="2.5"
              />
              <text x={blip.x} y={blip.y + 3.2} textAnchor="middle" className="today-radar-blip-t">
                {blip.abbr}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 min-h-[36px] max-w-[300px] text-center text-[12px] leading-[1.5] text-text-muted">
        {hovered ? (
          <>
            <b className="block font-semibold text-text-primary">{hovered.title}</b>
            <span className="line-clamp-2">{hovered.whyItMatters || hovered.summary}</span>
          </>
        ) : (
          <>
            <b className="block font-semibold text-text-secondary">
              {t('today.radar.captionTitle')}
            </b>
            <span>{t('today.radar.captionHint')}</span>
          </>
        )}
      </figcaption>
    </figure>
  );
}
